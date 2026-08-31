import { classifyJobPost } from './src/telegram/job-classifier.js';
const r = await classifyJobPost('Amazon | SDE Intern | 2027\nApply: https://amazon.jobs/en/jobs/12345');
console.log(JSON.stringify(r));
