import { classifyJobPost } from './src/telegram/job-classifier.js';
import { llmModelName } from './src/llm/client.js';

const samples = [
  'Amazon | SDE Intern | 2027\nApply: https://amazon.jobs/en/jobs/12345',
  '🚨 AMAZON HIRING 🚨\nSoftware Engineer Intern\nApply: https://amazon.jobs/x',
  'Join our Telegram channel for daily updates! t.me/somechannel',
];

console.log('model:', llmModelName());
for (const s of samples) {
  const r = await classifyJobPost(s);
  console.log('---');
  console.log(JSON.stringify(r));
}
