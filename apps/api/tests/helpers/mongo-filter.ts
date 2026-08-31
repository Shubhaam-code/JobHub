/**
 * A tiny in-memory evaluator for the slice of MongoDB query syntax the job
 * routes use.
 *
 * These tests run without a live MongoDB, so a filter could otherwise only be
 * asserted on its shape. This runs it instead: fixtures go in and the documents
 * that come back out are the ones the server would have received — which is what
 * makes a rule expressed as a query (the 21-day window) testable end to end
 * rather than by inspection.
 *
 * Faithful to MongoDB on the three rules that decide the expiry cases: a `null`
 * match also matches a missing field, a range operator never matches a missing
 * one, and an unknown operator is an error rather than a silent pass.
 */

import mongoose from 'mongoose';

type Doc = Record<string, unknown>;
type Filter = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp) &&
    !(value instanceof mongoose.Types.ObjectId)
  );
}

/** `{ $gt: … }` — a condition — as opposed to `{ …: … }`, a value to match. */
function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

/** Ordering is only defined for the dates and numbers these filters compare. */
function comparable(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return null;
}

function equals(value: unknown, expected: unknown): boolean {
  // MongoDB matches a missing field with `null`, which is what lets one filter
  // cover both a new document and a row stored before the field existed.
  if (expected === null) return value === null || value === undefined;
  if (expected instanceof Date) return value instanceof Date && value.getTime() === expected.getTime();
  if (expected instanceof RegExp) return typeof value === 'string' && expected.test(value);
  // Mongoose casts an id string to an ObjectId before the driver sees it.
  if (typeof expected === 'string' && value instanceof mongoose.Types.ObjectId) {
    return value.toString() === expected;
  }
  return value === expected;
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (!isOperatorObject(condition)) return equals(value, condition);

  return Object.entries(condition).every(([operator, operand]) => {
    switch (operator) {
      case '$eq':
        return equals(value, operand);
      case '$ne':
        return !equals(value, operand);
      case '$in':
        return (operand as unknown[]).some((entry) => equals(value, entry));
      case '$nin':
        return !(operand as unknown[]).some((entry) => equals(value, entry));
      case '$not':
        return !matchesCondition(value, operand);
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte': {
        const left = comparable(value);
        const right = comparable(operand);
        // A missing or non-comparable field never satisfies a range operator.
        if (left === null || right === null) return false;
        if (operator === '$gt') return left > right;
        if (operator === '$gte') return left >= right;
        if (operator === '$lt') return left < right;
        return left <= right;
      }
      default:
        throw new Error(`matchesMongoFilter: unsupported operator "${operator}"`);
    }
  });
}

/** Whether one document would be returned by `filter`. */
export function matchesMongoFilter(doc: Doc, filter: Filter): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') return (condition as Filter[]).every((sub) => matchesMongoFilter(doc, sub));
    if (key === '$or') return (condition as Filter[]).some((sub) => matchesMongoFilter(doc, sub));
    if (key === '$nor') return !(condition as Filter[]).some((sub) => matchesMongoFilter(doc, sub));
    if (key.startsWith('$')) {
      throw new Error(`matchesMongoFilter: unsupported top-level operator "${key}"`);
    }

    return matchesCondition(doc[key], condition);
  });
}

/** `filter` applied to a collection, in the order the documents were given. */
export function queryDocs<T extends Doc>(docs: T[], filter: Filter): T[] {
  return docs.filter((doc) => matchesMongoFilter(doc, filter));
}
