/**
 * The vocabulary the matcher uses to spot skills in text.
 *
 * Telegram job posts have no skills field, so skills are read out of the text
 * the ingestion pipeline already stores. That only works against a closed list:
 * an open-ended "capitalised words are skills" heuristic turns "Immediate Joiner"
 * into a requirement. Every entry here is a real, checkable technology.
 *
 * Each entry is `[canonical, ...aliases]`. The canonical form is what a user is
 * shown; aliases exist so "node.js", "nodejs" and "Node JS" are one skill.
 * Internal separators are matched loosely (see `skillPattern`), so an alias only
 * needs to be listed once per spelling that differs in letters, not punctuation.
 */
const SKILL_ENTRIES: readonly (readonly string[])[] = [
  // ── Languages ───────────────────────────────────────────────────────────
  ['Java'],
  ['Python'],
  ['JavaScript', 'js'],
  ['TypeScript', 'ts'],
  ['C++', 'cpp'],
  ['C#', 'csharp', 'c sharp'],
  ['C'],
  ['Go', 'golang'],
  ['Rust'],
  ['Ruby'],
  ['PHP'],
  ['Swift'],
  ['Kotlin'],
  ['Objective-C'],
  ['Scala'],
  ['Dart'],
  ['R'],
  ['MATLAB'],
  ['Perl'],
  ['Shell', 'bash', 'shell scripting'],
  ['PowerShell'],
  ['SQL'],
  ['HTML'],
  ['CSS'],
  ['Sass', 'scss'],
  ['Solidity'],
  ['VBA'],
  ['Assembly'],

  // ── Frontend ────────────────────────────────────────────────────────────
  ['React', 'reactjs'],
  ['Next.js', 'nextjs'],
  ['Angular', 'angularjs'],
  ['Vue', 'vuejs'],
  ['Svelte'],
  ['Redux'],
  ['jQuery'],
  ['Bootstrap'],
  ['Tailwind CSS', 'tailwind'],
  ['Material UI', 'mui'],
  ['Webpack'],
  ['Vite'],
  ['Three.js', 'threejs'],
  ['React Native'],
  ['Flutter'],
  ['Ionic'],
  ['jQuery UI'],
  ['Figma'],
  ['Adobe XD'],
  ['Photoshop'],
  ['Illustrator'],

  // ── Backend / frameworks ────────────────────────────────────────────────
  ['Spring Boot', 'springboot'],
  ['Spring'],
  ['Hibernate'],
  ['Node.js', 'nodejs', 'node'],
  ['Express.js', 'expressjs', 'express'],
  ['NestJS'],
  ['Django'],
  ['Flask'],
  ['FastAPI'],
  ['Ruby on Rails', 'rails'],
  ['Laravel'],
  ['ASP.NET', 'aspnet'],
  ['.NET', 'dotnet'],
  ['GraphQL'],
  ['REST API', 'rest apis', 'rest', 'restful'],
  ['gRPC'],
  ['Microservices'],
  ['WebSockets', 'websocket'],
  ['Socket.IO', 'socketio'],
  ['JWT'],
  ['OAuth'],
  ['Servlets'],
  ['JSP'],
  ['Maven'],
  ['Gradle'],
  ['JUnit'],
  ['Mockito'],

  // ── Data stores ─────────────────────────────────────────────────────────
  ['MongoDB', 'mongo'],
  ['PostgreSQL', 'postgres', 'psql'],
  ['MySQL'],
  ['SQLite'],
  ['Oracle'],
  ['SQL Server', 'mssql'],
  ['Redis'],
  ['Cassandra'],
  ['DynamoDB'],
  ['Elasticsearch'],
  ['Firebase'],
  ['Supabase'],
  ['Neo4j'],
  ['Prisma'],
  ['Mongoose'],
  ['Snowflake'],
  ['BigQuery'],
  ['Redshift'],

  // ── Cloud / infra ───────────────────────────────────────────────────────
  ['AWS', 'amazon web services'],
  ['Azure'],
  ['Google Cloud', 'gcp'],
  ['Docker'],
  ['Kubernetes', 'k8s'],
  ['Terraform'],
  ['Ansible'],
  ['Jenkins'],
  ['GitHub Actions'],
  ['GitLab CI'],
  ['CI/CD', 'cicd', 'ci cd'],
  ['Linux'],
  ['Nginx'],
  ['Apache Kafka', 'kafka'],
  ['RabbitMQ'],
  ['Serverless'],
  ['Lambda', 'aws lambda'],
  ['EC2'],
  ['S3'],
  ['Prometheus'],
  ['Grafana'],
  ['Datadog'],

  // ── Data / ML ───────────────────────────────────────────────────────────
  ['Machine Learning', 'ml'],
  ['Deep Learning'],
  ['TensorFlow'],
  ['PyTorch'],
  ['Keras'],
  ['scikit-learn', 'sklearn'],
  ['Pandas'],
  ['NumPy'],
  ['OpenCV'],
  ['NLP', 'natural language processing'],
  ['Computer Vision'],
  ['Data Analysis', 'data analytics'],
  ['Data Science'],
  ['Power BI', 'powerbi'],
  ['Tableau'],
  ['Excel'],
  ['Apache Spark', 'spark'],
  ['Hadoop'],
  ['Airflow'],
  ['ETL'],
  ['LLM', 'large language models'],
  ['Generative AI', 'gen ai', 'genai'],

  // ── Practices / tools ───────────────────────────────────────────────────
  ['Git'],
  ['GitHub'],
  ['GitLab'],
  ['Jira'],
  ['Agile'],
  ['Scrum'],
  ['DSA', 'data structures and algorithms', 'data structures'],
  ['Algorithms'],
  ['OOP', 'object oriented programming'],
  ['System Design'],
  ['DBMS'],
  ['Operating Systems'],
  ['Computer Networks', 'networking'],
  ['Unit Testing'],
  ['Selenium'],
  ['Cypress'],
  ['Jest'],
  ['Playwright'],
  ['Postman'],
  ['Manual Testing'],
  ['Automation Testing', 'test automation'],
  ['SEO'],
  ['Digital Marketing'],
  ['Content Writing'],
  ['Canva'],
  ['Android'],
  ['iOS'],
  ['Unity'],
  ['Blockchain'],
  ['Cybersecurity', 'cyber security'],
  ['Penetration Testing'],
];

/**
 * Characters that continue a token. Used as lookaround so "Java" does not match
 * inside "JavaScript" and "C" does not match inside "CSS", while "C++" and "C#"
 * still match as themselves.
 */
const TOKEN_CHAR = 'a-z0-9+#';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a matcher for one spelling, tolerating any punctuation or spacing
 * between its words: "node.js", "node js", "node-js" and "nodejs" all match.
 */
function skillPattern(alias: string): RegExp {
  const loose = alias
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((part) => part.length > 0)
    .map((part) => escapeRegex(part))
    .join('[^a-z0-9+#]*');

  return new RegExp(`(?<![${TOKEN_CHAR}])${loose}(?![${TOKEN_CHAR}])`, 'i');
}

interface CompiledSkill {
  canonical: string;
  patterns: RegExp[];
}

const COMPILED_SKILLS: CompiledSkill[] = SKILL_ENTRIES.map((entry) => ({
  canonical: entry[0] as string,
  patterns: entry.map((alias) => skillPattern(alias)),
}));

/** Canonical label for a skill spelling, or null when it is not in the list. */
export function canonicalizeSkill(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  for (const skill of COMPILED_SKILLS) {
    for (const pattern of skill.patterns) {
      // Anchored: canonicalizing is an equality test, not a search.
      if (new RegExp(`^${pattern.source}$`, 'i').test(trimmed)) {
        return skill.canonical;
      }
    }
  }

  return null;
}

/**
 * Drops skills wholly contained in a longer match, so a post naming "Spring
 * Boot" reports that rather than "Spring" as well.
 */
function dropSubsumed(skills: string[]): string[] {
  return skills.filter((skill) => {
    const lower = skill.toLowerCase();
    return !skills.some((other) => {
      if (other === skill) return false;
      const otherLower = other.toLowerCase();
      return otherLower.length > lower.length && otherLower.includes(lower);
    });
  });
}

/**
 * Every dictionary skill named in `text`, canonicalized and de-duplicated.
 *
 * This is how a job's required skills are derived: from the text the ingestion
 * pipeline already stored, with no second job table and no LLM call per job.
 */
export function extractSkills(text: string): string[] {
  if (text.length === 0) return [];

  const found: string[] = [];

  for (const skill of COMPILED_SKILLS) {
    if (skill.patterns.some((pattern) => pattern.test(text))) {
      found.push(skill.canonical);
    }
  }

  return dropSubsumed(found);
}

/**
 * Normalizes user-entered skills: dictionary spellings become canonical, and
 * anything unrecognised is kept as typed so a niche skill is not silently lost.
 */
export function normalizeSkillList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;

    const canonical = canonicalizeSkill(trimmed) ?? trimmed;
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(canonical);
  }

  return result;
}

/** Exposed for tests: how many skills the dictionary knows. */
export const SKILL_COUNT = COMPILED_SKILLS.length;
