import { openDb } from './db.js';
import { createApp } from './routes.js';
import { defaultWorkflowsDir } from './workflows.js';

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? 'data/screening.db';
const workflowsDir = process.env.WORKFLOWS_DIR ?? defaultWorkflowsDir();

const app = createApp(openDb(dbPath), workflowsDir);
app.listen(port, () => {
  console.log(`api listening on :${port} (db: ${dbPath}, workflows: ${workflowsDir})`);
});
