const { Queue } = require("bullmq");
async function test() {
  const queue = new Queue("prospect-search", {
    connection: { host: "127.0.0.1", port: 16379 }
  });
  console.log("=== Injecting test job ===");
  const job = await queue.add("execute-search", {
    taskId: "test-inject-002",
    companyId: "4a2d4fee-3a6c-41d9-b91d-9d78ca3ebc43",
    keywords: ["test injection"],
    targetCountry: "USA",
    maxResults: 5
  }, { jobId: "test-inject-002" });
  console.log("Job added:", job.id);
  await new Promise(r => setTimeout(r, 15000));
  const state = await job.getState();
  console.log("State after 15s:", state);
  await job.remove().catch(()=>{});
  await queue.close();
  console.log("Complete");
}
test().catch(e => console.error(e.message));
