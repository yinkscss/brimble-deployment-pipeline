import cors from "cors";
import express from "express";
import multer from "multer";
import { ulid } from "ulid";
import { z } from "zod";
import {
  createDeployment,
  getDeployment,
  getLogs,
  initDb,
  listDeployments,
  setDeploymentStatus,
  updateDeployment
} from "./db.js";
import { publishEvent, subscribe, unsubscribe } from "./logHub.js";
import { destroyContainer, processDeployment, processUploadedDeployment, removeCaddyRouteByPath } from "./pipeline.js";

const app = express();
const port = Number(process.env.PORT ?? "3001");
const deploymentSchema = z.object({ git_url: z.string().url().optional() });
const upload = multer({ dest: "/app/tmp/uploads" });

app.use(cors());
app.use(express.json());

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/deployments", upload.single("project_file"), async (req, res) => {
  const parsed = deploymentSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });

  const gitUrl = parsed.data.git_url;
  const uploaded = req.file;
  if (!gitUrl && !uploaded) {
    return res.status(400).json({ error: "Provide either git_url or project_file (.zip)" });
  }

  const deployment = await createDeployment(ulid(), gitUrl ?? `upload://${uploaded?.originalname ?? "project.zip"}`);
  if (gitUrl) void processDeployment(deployment.id, gitUrl);
  else if (uploaded?.path) void processUploadedDeployment(deployment.id, uploaded.path);
  res.status(201).json(deployment);
});

app.get("/deployments", async (_, res) => {
  const rows = await listDeployments();
  res.json(rows);
});

app.get("/deployments/:id", async (req, res) => {
  const row = await getDeployment(req.params.id);
  if (!row) return res.status(404).json({ error: "Deployment not found" });
  res.json(row);
});

app.get("/deployments/:id/logs", async (req, res) => {
  const deployment = await getDeployment(req.params.id);
  if (!deployment) return res.status(404).json({ error: "Deployment not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const existing = await getLogs(req.params.id);
  for (const log of existing) {
    res.write(
      `data: ${JSON.stringify({
        line: log.line,
        stream: log.stream,
        timestamp: log.timestamp
      })}\n\n`
    );
  }

  const heartbeat = setInterval(() => {
    res.write(":keepalive\n\n");
  }, 15000);

  subscribe(req.params.id, res);
  if (deployment.status === "running") {
    res.write(`event: done\ndata: ${JSON.stringify({ status: "running", caddy_route: deployment.caddy_route })}\n\n`);
  } else if (deployment.status === "failed") {
    res.write(`event: error\ndata: ${JSON.stringify({ status: "failed" })}\n\n`);
  }
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe(req.params.id, res);
  });
});

app.delete("/deployments/:id", async (req, res) => {
  const deployment = await getDeployment(req.params.id);
  if (!deployment) return res.status(404).json({ error: "Deployment not found" });

  try {
    if (deployment.container_id) await destroyContainer(deployment.container_id);
    if (deployment.caddy_route) await removeCaddyRouteByPath(deployment.caddy_route);
    await updateDeployment(req.params.id, {
      container_id: null,
      caddy_route: null
    });
    await setDeploymentStatus(req.params.id, "failed");
    publishEvent(req.params.id, "done", { status: "deleted" });
    res.status(204).send();
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Delete failed"
    });
  }
});

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`API listening on ${port}`);
    });
  })
  .catch((error) => {
    console.error("DB init failed", error);
    process.exit(1);
  });
