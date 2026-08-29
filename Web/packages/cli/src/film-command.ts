//
//  film-command.ts - `despia film`, the CLI face over the film pipeline
//  (12-marketing-video.md). Thin like shot-command: the CLI, the MCP tool the command table
//  generates, and the Studio door all call the same reader/validator/renderer, so none of
//  the three re-decides what a lawful film is.
//
//    despia film check  <composition.dsx>       parse + validate, render nothing
//    despia film render <composition.dsx>       render (webm preview; --master for mp4)
//

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { findProjectRoot, loadConfig } from "./config.ts";
import { loadFilmDocument, FilmDocumentError } from "./film-document.ts";
import { renderFilm, ffmpegAvailable } from "./film-render.ts";
import { findWebRoot } from "./shot-render.ts";
import { launchShotBrowser } from "./shot-browser.ts";

type Io = { out(text: string): void; err(text: string): void };

function webRoot(): string {
  return findWebRoot(import.meta.url);
}

export async function commandFilm(
  flags: { [k: string]: string | boolean | undefined },
  positional: string[],
  io: Io,
): Promise<number> {
  const [sub, docArg] = positional;
  if (sub !== "check" && sub !== "render") {
    io.err("usage: despia film check|render <composition.dsx> [--master] [--out DIR] [--frames N]");
    return 1;
  }
  if (docArg === undefined) {
    io.err("name the film document: despia film " + sub + " marketing/<name>/composition.dsx");
    return 1;
  }
  const docPath = resolve(docArg);
  if (!existsSync(docPath)) {
    io.err(`no film document at ${docPath}`);
    return 1;
  }
  const start = typeof flags["project"] === "string" ? flags["project"] : dirname(docPath);
  const root = findProjectRoot(start);
  if (root === null) {
    io.err("no dsx.config.json found above the composition - pass --project");
    return 1;
  }

  let loaded;
  try {
    loaded = loadFilmDocument(docPath);
  } catch (e) {
    if (e instanceof FilmDocumentError) { io.err(`film: ${e.message}`); return 1; }
    throw e;
  }
  const { film, problems } = loaded;

  io.out(`despia film ${sub}: ${film.id} - ${film.durationMs / 1000}s at ${film.fps}fps, `
    + `${film.format.width}x${film.format.height}, ${film.scenes.length} scene(s)`);
  for (const p of problems) io.err(`  refused [${p.code}] ${p.message}`);
  if (problems.length > 0) {
    io.err("Nothing renders from an unlawful film - the refusal is the deliverable.");
    return 1;
  }
  if (sub === "check") {
    io.out(`  lawful - ${film.durationMs * film.fps / 1000} frames when rendered`);
    io.out(`  master tier (mp4/H.264): ${ffmpegAvailable() ? "ffmpeg found" : "NOT available - ffmpeg is not on PATH; the webm preview tier needs nothing"}`);
    return 0;
  }

  const config = loadConfig(root);
  const outDir = typeof flags["out"] === "string" ? resolve(flags["out"]) : dirname(docPath);
  const frameLimit = typeof flags["frames"] === "string" ? Number(flags["frames"]) : undefined;
  const browser = await launchShotBrowser();
  try {
    const outcome = await renderFilm(browser, config, film, {
      webRoot: webRoot(), projectRoot: root, outDir,
      encoder: flags["master"] === true ? "mp4" : "webm",
      frameLimit: frameLimit !== undefined && Number.isFinite(frameLimit) ? frameLimit : undefined,
      onProgress: (frame, total) => {
        if (frame % 30 === 0 || frame === total) io.out(`  frame ${frame}/${total}`);
      },
    });
    for (const e of outcome.errors) io.err(`  ${e}`);
    if (!outcome.ok) {
      io.err("No video was written - a refused frame is never published.");
      return 1;
    }
    io.out(`  wrote ${outcome.videoPath} (${outcome.frameCount} frames)`);
    return 0;
  } finally {
    await (browser as unknown as { close(): Promise<void> }).close();
  }
}
