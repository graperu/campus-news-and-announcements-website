import { connect, migrate } from '../../backend/db.mjs';
import { readReviewedSource, restoreReviewedSource } from './source-content.mjs';
const snapshot = await readReviewedSource();
const db = await connect();
try {
  await migrate(db);
  const result = await restoreReviewedSource(db, snapshot);
  console.log(
    `Restored ${result.records} reviewed UTH articles; activated ${result.activated} versions; linked ${result.documents} original PDFs. No accounts created.`,
  );
} finally {
  await db.close();
}
