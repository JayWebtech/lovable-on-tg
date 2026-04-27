import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
import { eq, sql } from "drizzle-orm";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import axios from "axios";
import { db } from "../../db/index.js";
import { builds, users } from "../../db/schema.js";
import { logger } from "../../utils/logger.js";
import { notifyAdmin } from "../../utils/adminNotify.js";
import { generateWebsite } from "../../services/claude.js";
import {
  createEnvironment,
  createProject,
  createS3GitService,
  InsufficientCreditsError,
  resolveGitRemoteUrl,
  getDeployment,
} from "../../services/locus.js";
import type { Job } from "bullmq";
import type { BuildJobData } from "../types.js";

const SITE_DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
`;

const SITE_PACKAGE_JSON = JSON.stringify(
  { name: "sitebot-site", private: true, type: "commonjs", dependencies: { express: "^4.21.0" } },
  null,
  2,
);

const SITE_SERVER_JS = `const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('*', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});
app.listen(PORT, () => console.log('Server running on port', PORT));
`;

async function editStatus(
  bot: Bot<Context>,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  if (!messageId) {
    await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
    return;
  }
  try {
    await bot.api.editMessageText(chatId, messageId, text, { parse_mode: "Markdown" });
  } catch (e) {
    logger.warn("editMessageText failed; sending new message", { err: String(e) });
    await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
  }
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stderr, stdout } = await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stderr?.length && !stderr.includes("→")) logger.debug("git stderr", { stderr: stderr.slice(0, 500) });
  if (stdout?.length) logger.debug("git stdout", { stdout: stdout.slice(0, 500) });
  return { stdout, stderr };
}

async function pushBundleToLocus(projectId: string, dir: string): Promise<string> {
  const remote = await resolveGitRemoteUrl(projectId);
  await runGit(dir, ["init"]);
  await runGit(dir, ["branch", "-M", "main"]);
  await runGit(dir, ["config", "user.email", "sitebot@users.noreply.buildwithlocus.com"]);
  await runGit(dir, ["config", "user.name", "SiteBot"]);
  await runGit(dir, ["add", "."]);
  await runGit(dir, ["commit", "-m", "SiteBot deploy"]);
  await runGit(dir, ["remote", "add", "locus", remote]);
  const { stdout, stderr } = await runGit(dir, ["push", "-u", "locus", "main"]);

  const output = stdout + "\\n" + stderr;
  const match = output.match(/deploy_[a-zA-Z0-9]+/);
  if (match) {
    return match[0];
  }
  throw new Error("Could not extract deployment ID from git push output");
}

export function createBuildProcessor(bot: Bot<Context>) {
  return async (job: Job<BuildJobData>): Promise<void> => {
    const { buildId, telegramId, chatId, messageId, prompt } = job.data;
    logger.info("Worker: Processing build job", { buildId, telegramId });
    const expiryDays = Number.parseInt(process.env.SITE_EXPIRY_DAYS ?? "7", 10);


    const refundCredit = async () => {
      try {
        await db.update(users).set({ credits: sql`${users.credits} + 1` }).where(eq(users.telegramId, BigInt(telegramId)));
        await bot.api.sendMessage(chatId, "🎟️ _Your Build Credit has been automatically refunded._", { parse_mode: "Markdown" }).catch(() => { });
      } catch (e) {
        logger.error("Failed to refund credit", { err: String(e), buildId });
      }
    };

    try {
      await db.update(builds).set({ status: "generating" }).where(eq(builds.id, buildId));
      await editStatus(
        bot,
        chatId,
        messageId,
        "🎨 *Generating your website with AI...*\n\n_Build ID: " + buildId + "_",
      );

      let html: string;
      const typingInterval = setInterval(() => {
        bot.api.sendChatAction(chatId, "typing").catch(() => { });
      }, 4000);
      try {
        html = await generateWebsite(prompt);
      } catch {
        await db
          .update(builds)
          .set({ status: "failed", errorMessage: "AI generation failed" })
          .where(eq(builds.id, buildId));
        await bot.api.sendMessage(
          chatId,
          "😔 AI generation failed. Please try a different prompt.",
        );
        await refundCredit();
        return;
      } finally {
        clearInterval(typingInterval);
      }

      await db.update(builds).set({ generatedHtml: html }).where(eq(builds.id, buildId));
      await editStatus(
        bot,
        chatId,
        messageId,
        "🏗️ *Building and deploying on Locus...*\n\n_Build ID: " + buildId + "_",
      );
      await db.update(builds).set({ status: "deploying" }).where(eq(builds.id, buildId));

      const projectName = `sitebot-${buildId.slice(0, 8)}`;
      let projectId: string;
      let serviceId: string;
      let deploymentId: string;
      let serviceUrl: string | undefined;

      try {
        const proj = await createProject(projectName);
        projectId = proj.id;
        const env = await createEnvironment(projectId);
        const svc = await createS3GitService(projectId, env.id, "web");
        serviceId = svc.id;
        serviceUrl = svc.url;

        const work = join(tmpdir(), `sitebot-${buildId}`);
        await rm(work, { recursive: true, force: true });
        await mkdir(work, { recursive: true });
        await writeFile(join(work, "index.html"), html, "utf8");
        await writeFile(join(work, "server.js"), SITE_SERVER_JS, "utf8");
        await writeFile(join(work, "package.json"), SITE_PACKAGE_JSON, "utf8");
        await writeFile(join(work, "Dockerfile"), SITE_DOCKERFILE, "utf8");

        deploymentId = await pushBundleToLocus(projectId, work);
        await rm(work, { recursive: true, force: true });
      } catch (e) {
        if (e instanceof InsufficientCreditsError) {
          await db
            .update(builds)
            .set({ status: "failed", errorMessage: "Insufficient Locus credits" })
            .where(eq(builds.id, buildId));
          await notifyAdmin(bot, `Insufficient Locus credits during build ${buildId}.`);
          await bot.api.sendMessage(
            chatId,
            "🔧 System maintenance. Try again shortly.",
          );
          await refundCredit();
          return;
        }
        logger.error("Locus setup or git push failed", { err: String(e), buildId });
        await db
          .update(builds)
          .set({ status: "failed", errorMessage: "Deployment failed" })
          .where(eq(builds.id, buildId));
        await bot.api.sendMessage(
          chatId,
          "⚠️ Deployment failed. Our team has been notified.",
        );
        await refundCredit();
        return;
      }

      await db
        .update(builds)
        .set({
          locusProjectId: projectId,
          locusServiceId: serviceId,
          locusDeploymentId: deploymentId,
        })
        .where(eq(builds.id, buildId));

      const mapStatus = (s: string): string => {
        if (s === "queued") return "⏳ Build queued...";
        if (s === "building") return "🔨 Building container...";
        if (s === "deploying") return "🚀 Deploying...";
        return `📡 Status: ${s}`;
      };

      let isLive = false;
      const startPoll = Date.now();
      let lastPollMsg = "";
      let lastDeploymentFetch = 0;

      while (Date.now() - startPoll < 10 * 60 * 1000) {
        try {
          const checkUrl = serviceUrl?.startsWith("http") ? serviceUrl : `https://${serviceUrl}`;
          const res = await axios.get(checkUrl, { timeout: 5000, validateStatus: () => true });
          if (res.status === 200) {
            isLive = true;
            break;
          }
        } catch (e) {
          // ignore
        }

        const now = Date.now();
        // Only hit the Locus Build API every 60 seconds as recommended by docs
        if (now - lastDeploymentFetch >= 60_000) {
          lastDeploymentFetch = now;
          try {
            const { status } = await getDeployment(deploymentId);
            const msg = mapStatus(status);
            const interesting = status === "queued" || status === "building" || status === "deploying" || status === "failed";

            if (interesting && msg !== lastPollMsg) {
              lastPollMsg = msg;
              void editStatus(bot, chatId, messageId, `${msg}\\n\\n_Build ID: ${buildId}_`).catch(() => undefined);
            }
          } catch (e) {
            // ignore API timeouts
          }
        }

        // Wait 15 seconds before pinging the domain again (non-blocking for Node)
        await new Promise(r => setTimeout(r, 15_000));
      }

      if (!isLive) {
        await db
          .update(builds)
          .set({ status: "failed", errorMessage: "Deployment unhealthy or timed out" })
          .where(eq(builds.id, buildId));
        await bot.api.sendMessage(
          chatId,
          "⚠️ Deployment did not become healthy in time. Please contact support with your build ID.",
        );
        await refundCredit();
        return;
      }

      const completedAt = new Date();
      const expiresAt = new Date(completedAt.getTime() + expiryDays * 24 * 60 * 60 * 1000);
      const siteUrl = serviceUrl ?? "";

      await db
        .update(builds)
        .set({
          status: "live",
          siteUrl,
          completedAt,
          expiresAt,
        })
        .where(eq(builds.id, buildId));

      await db
        .update(users)
        .set({ totalBuilds: sql`${users.totalBuilds} + 1` })
        .where(eq(users.telegramId, BigInt(telegramId)));

      const openUrl =
        siteUrl && siteUrl.length > 0
          ? siteUrl.startsWith("http")
            ? siteUrl
            : `https://${siteUrl}`
          : "";

      const kb = new InlineKeyboard();
      if (openUrl) kb.url("🌍 Open site", openUrl).row();
      kb.text("🌐 Buy Custom Domain", `domain:${buildId}`);

      await bot.api.sendMessage(
        chatId,
        `✅ *Your site is live!*\n\n${openUrl || "(URL pending — check /status)"}\n\n_Build ID: ${buildId}_`,
        { parse_mode: "Markdown", reply_markup: kb },
      );
    } catch (e) {
      logger.error("buildSite job crashed", { err: String(e), buildId });
      try {
        await db
          .update(builds)
          .set({ status: "failed", errorMessage: "Unexpected worker error" })
          .where(eq(builds.id, buildId));
        await bot.api.sendMessage(chatId, "⚠️ Something went wrong while building your site.");
        await refundCredit();
      } catch (inner) {
        logger.error("Failed to notify user of crash", { err: String(inner) });
      }
    }
  };
}
