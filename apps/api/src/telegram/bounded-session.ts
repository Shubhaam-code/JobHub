/**
 * A `StringSession` whose entity store cannot grow without bound.
 *
 * ── The leak ──────────────────────────────────────────────────────────────
 *
 * `MemorySession` (which `StringSession` extends) keeps resolved peers in a
 * plain `Set`:
 *
 *     this._entities = new Set();
 *
 *     processEntities(tlo) {
 *       const entitiesSet = this._entitiesToRows(tlo);
 *       for (const e of entitiesSet) this._entities.add(e);
 *     }
 *
 * `_entitiesToRows` builds a **freshly allocated array** per entity
 * (`[id, hash, username, phone, name]`). A `Set` dedups by identity, and two
 * distinct arrays are never identical — so `add` appends a new row every single
 * time, even for a peer already in the store.
 *
 * GramJS calls `processEntities` on every update (`client/updates.js`) and on
 * every API result (`client/users.js`). A long-lived listener therefore
 * accumulates one row per message forever, for the same handful of channels.
 * Measured against a simulation of this deployment's 17 channels: 50,000 rows
 * and ~26 MB of retained heap, growing monotonically and never released. On a
 * 512 MB Render instance that is what eventually trips the memory limit — and
 * it explains the shape of the failure, a service that dies after being *up*
 * for a while rather than under load.
 *
 * It also degrades CPU: `getEntityRowsByPhone/Username/Name/ById` are O(n)
 * linear scans over that same `Set`.
 *
 * ── The fix ───────────────────────────────────────────────────────────────
 *
 * Store rows in a `Map` keyed by the marked peer id, so a re-seen peer
 * overwrites its row instead of adding one, and cap the map with LRU eviction
 * as a backstop. Nothing is lost: a row is pure lookup data (id, access hash,
 * username, phone, display name) that GramJS re-derives from the next update
 * mentioning that peer.
 *
 * The four `getEntityRowsBy*` readers are overridden to read the map — id
 * lookups become O(1); the rest stay linear but over a bounded collection.
 * `_entities` itself is kept in sync as a `Set` of the same row arrays, because
 * it is a `protected` field of the base class and cheap insurance against any
 * GramJS code path we have not overridden.
 *
 * Everything else is inherited untouched: auth key, DC, `save()`/`load()`
 * serialization. `TELEGRAM_SESSION` strings stay byte-for-byte compatible in
 * both directions, so this is a drop-in replacement for `StringSession`.
 */

import { StringSession } from 'telegram/sessions/index.js';

/**
 * Rows to keep. Well above this deployment's working set (~17 channels plus
 * the odd sender), small enough that the store can never be a memory problem:
 * a row is five short scalars, so 2,000 of them is on the order of 100 KB.
 */
const DEFAULT_MAX_ENTITIES = 2_000;

/** One `MemorySession` entity row: [id, hash, username, phone, name]. */
type EntityRow = (string | { toString(): string })[];

export class BoundedStringSession extends StringSession {
  /**
   * Rows by marked peer id — the keyed store the base class should have used.
   * `Map` preserves insertion order, which is what makes the eviction below LRU.
   */
  private readonly entityRows = new Map<string, EntityRow>();

  private readonly maxEntities: number;

  constructor(session?: string, maxEntities: number = DEFAULT_MAX_ENTITIES) {
    super(session);
    this.maxEntities = Math.max(1, maxEntities);
  }

  /** Rows currently held. Used by the memory reporter; never logs any row. */
  get entityCount(): number {
    return this.entityRows.size;
  }

  /**
   * Keyed, capped replacement for the base implementation.
   *
   * Same effect as the original — every peer in `tlo` becomes retrievable — but
   * re-seeing a peer refreshes one entry instead of appending another.
   */
  override processEntities(tlo: unknown): void {
    // Row construction is inherited, so the row shape stays exactly what the
    // base class's readers expect.
    const rows = this._entitiesToRows(tlo) as EntityRow[];

    for (const row of rows) {
      const id = row[0];
      if (id === undefined) continue;

      const key = String(id);

      // Delete-then-set moves an existing key to the end of the insertion
      // order, so the eviction below drops the least recently seen peer.
      this.entityRows.delete(key);
      this.entityRows.set(key, row);
    }

    if (this.entityRows.size > this.maxEntities) {
      for (const key of this.entityRows.keys()) {
        if (this.entityRows.size <= this.maxEntities) break;
        this.entityRows.delete(key);
      }
    }

    // Mirror into the inherited field for any base-class path not overridden
    // here. Rebuilt from the map, so it is bounded by the same cap.
    this._entities = new Set(this.entityRows.values());
  }

  /** O(1) now, instead of a linear scan. */
  override getEntityRowsById(
    id: string | { toString(): string },
    exact = true,
  ): unknown[] | undefined {
    if (exact) {
      const row = this.entityRows.get(String(id));
      return row ? [row[0], row[1]] : undefined;
    }

    // Non-exact lookup means "this bare id under any peer type", which the base
    // class resolves by marking the id three ways. Delegating keeps that logic
    // in one place; it scans, but over a bounded map.
    return super.getEntityRowsById(id as never, exact);
  }

  override getEntityRowsByPhone(phone: string): unknown[] | undefined {
    return this.findBy(3, phone);
  }

  override getEntityRowsByUsername(username: string): unknown[] | undefined {
    return this.findBy(2, username);
  }

  override getEntityRowsByName(name: string): unknown[] | undefined {
    return this.findBy(4, name);
  }

  /** Shared linear probe over the bounded map, matching the base row layout. */
  private findBy(index: number, value: string): unknown[] | undefined {
    for (const row of this.entityRows.values()) {
      if (row[index] === value) return [row[0], row[1]];
    }
    return undefined;
  }

  /** Drops every cached row. Called on teardown; peers are re-learned on demand. */
  clearEntities(): void {
    this.entityRows.clear();
    this._entities = new Set();
  }
}
