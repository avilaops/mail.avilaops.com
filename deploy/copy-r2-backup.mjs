import { readFile, writeFile } from "node:fs/promises";
import { S3Client, ListObjectsV2Command, CopyObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const [credentialsFile, targetBucket, reportFile] = process.argv.slice(2);
if (!credentialsFile || !targetBucket || !reportFile || targetBucket === "avilaops-mail-backups") {
  throw new Error("Usage: node deploy/copy-r2-backup.mjs <private-credentials.json> <new-bucket> <report.json>");
}
const credentials = JSON.parse(await readFile(credentialsFile, "utf8"));
const s3 = new S3Client({ endpoint: credentials.endpoint, region: "auto", forcePathStyle: true, credentials });
const sourceBucket = "avilaops-mail-backups";
const prefix = "blobs/";
const objects = [];
let cursor;
do {
  const page = await s3.send(new ListObjectsV2Command({ Bucket: sourceBucket, Prefix: prefix, ContinuationToken: cursor }));
  for (const object of page.Contents ?? []) {
    if (!object.Key || !/^blobs\/\d{4}\/(?:0[1-9]|1[0-2])\/[A-Za-z0-9_-]+\.eml\.gz$/.test(object.Key)) {
      throw new Error("Unexpected source object key; copy stopped before modification.");
    }
    objects.push({ key: object.Key, size: object.Size });
  }
  cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (cursor);
if (objects.length === 0) throw new Error("Backup contains no message objects.");
const report = { sourceBucket, sourcePrefix: prefix, targetBucket, totalObjects: objects.length, totalBytes: objects.reduce((sum, o) => sum + o.size, 0), copied: 0, failed: 0, status: "copying", startedAt: new Date().toISOString() };
await writeFile(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
async function copy(object) {
  const key = object.key.slice(prefix.length);
  await s3.send(new CopyObjectCommand({ Bucket: targetBucket, Key: key, CopySource: `${sourceBucket}/${object.key.split("/").map(encodeURIComponent).join("/")}` }));
  return key;
}
// Check cross-bucket server-side copy support and exact length before parallel work.
const firstKey = await copy(objects[0]);
const first = await s3.send(new HeadObjectCommand({ Bucket: targetBucket, Key: firstKey }));
if (first.ContentLength !== objects[0].size) throw new Error("Destination object length differs from source.");
report.copied = 1;
let next = 1;
let stopped = false;
const workers = Array.from({ length: 24 }, async () => {
  while (!stopped && next < objects.length) {
    const object = objects[next++];
    try {
      await copy(object);
      report.copied++;
      if (report.copied % 1000 === 0) console.log(JSON.stringify({ copied: report.copied, total: objects.length }));
    } catch (error) {
      stopped = true;
      report.failed++;
      throw error;
    }
  }
});
const results = await Promise.allSettled(workers);
report.status = results.some((result) => result.status === "rejected") ? "failed" : "complete";
report.finishedAt = new Date().toISOString();
await writeFile(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (report.status !== "complete") throw new Error("R2 message copy incomplete; inspect private recovery state.");
