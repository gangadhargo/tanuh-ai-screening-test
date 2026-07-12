// The validation command promised by the authoring decision row:
//   npm run validate:workflows
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflow } from './parse.js';
import { validateWorkflow } from './validate.js';

const dir = process.argv[2] ?? 'workflows';
let failed = false;

for (const file of readdirSync(dir).filter((fileName) => fileName.endsWith('.xml'))) {
  const path = join(dir, file);
  try {
    const wf = parseWorkflow(readFileSync(path, 'utf8'));
    const errors = validateWorkflow(wf);
    if (errors.length) {
      failed = true;
      console.error(`✗ ${file}`);
      for (const e of errors) console.error(`  - ${e}`);
    } else {
      console.log(`✓ ${file} (${wf.id}@${wf.version}, ${wf.steps.length} steps)`);
    }
  } catch (error) {
    failed = true;
    console.error(`✗ ${file}: ${error.message}`);
  }
}

process.exit(failed ? 1 : 0);
