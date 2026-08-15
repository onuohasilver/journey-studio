// ---- Saved journeys on disk ----
//
// Plain JSON files in a `journeys/` directory, one per journey, meant to be
// committed. A journey that lives in the repo next to the code it tests is a
// regression test; one that lives in a browser tab is a demo.

import {readdir, readFile, writeFile, mkdir, unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import type {Request, Response, Router} from 'express';
import express from 'express';
import {fileNameFor, readSaved, type SavedJourney} from '../src/core/persist';
import {packSnapshot, readSnapshot, snapshotNameFor, type Shape, type SnapshotFile} from '../src/core/snapshot';
import {formatReport, sendToSlack} from '../src/core/slack';
import {loadConfig} from './config';
import type {QaReport} from '../src/core/report';

const DIR = 'journeys';
const SNAPSHOT_DIR = 'snapshots';

function dirFor(root: string): string {
  return path.join(root, DIR);
}

/**
 * Resolve a requested name to a path inside the journeys directory.
 *
 * The name arrives from an HTTP request, so it is untrusted: without this a
 * request for `../../.env` would read anything the process can.
 */
function safePath(root: string, name: string): string | undefined {
  const file = fileNameFor(name.replace(/\.journey\.json$/, ''));
  const full = path.resolve(dirFor(root), file);
  return full.startsWith(path.resolve(dirFor(root)) + path.sep) ? full : undefined;
}

/**
 * Snapshots live beside the journeys under their own directory, one file per
 * journey, meant to be committed and reviewed. A shape change showing up as a
 * diff in a pull request is the whole point — it turns "the API changed under
 * us" from something discovered in production into a line someone approved.
 */
function snapshotPath(root: string, name: string): string | undefined {
  const journeyFile = safePath(root, name);
  if (!journeyFile) return undefined;
  return path.join(root, SNAPSHOT_DIR, snapshotNameFor(path.basename(journeyFile)));
}

export async function loadSnapshot(root: string, name: string): Promise<SnapshotFile | undefined> {
  const file = snapshotPath(root, name);
  if (!file || !existsSync(file)) return undefined;
  return readSnapshot(await readFile(file, 'utf8'));
}

export async function saveSnapshot(
  root: string,
  name: string,
  nodes: Record<string, Shape>,
  meta: {journey?: string; env?: string} = {},
): Promise<string | undefined> {
  const file = snapshotPath(root, name);
  if (!file) return undefined;
  await mkdir(path.dirname(file), {recursive: true});
  const packed = packSnapshot(meta.journey ?? name, nodes, {env: meta.env});
  await writeFile(file, `${JSON.stringify(packed, null, 2)}\n`, 'utf8');
  return path.basename(file);
}

export interface JourneySummary {
  name: string;
  file: string;
  description?: string;
  savedAt: string;
  steps: number;
  /** How many rows a data-driven journey runs against. */
  cases: number;
  /** Whether a recorded shape exists to compare against. */
  snapshot: boolean;
}

export async function listJourneys(root: string): Promise<JourneySummary[]> {
  const dir = dirFor(root);
  if (!existsSync(dir)) return [];

  const files = (await readdir(dir)).filter((f) => f.endsWith('.journey.json'));
  const out: JourneySummary[] = [];
  for (const file of files) {
    try {
      const saved = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as SavedJourney;
      out.push({
        name: saved.name ?? file,
        file,
        description: saved.description,
        savedAt: saved.savedAt ?? '',
        steps: saved.journey?.nodes?.length ?? 0,
        cases: saved.journey?.cases?.length ?? 0,
        snapshot: existsSync(path.join(root, SNAPSHOT_DIR, snapshotNameFor(file))),
      });
    } catch {
      // A single unreadable file should not hide the rest of the suite.
      out.push({name: file, file, savedAt: '', steps: 0, cases: 0, snapshot: false, description: 'could not be read'});
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadJourney(root: string, name: string): Promise<SavedJourney | undefined> {
  const file = safePath(root, name);
  if (!file || !existsSync(file)) return undefined;
  const result = readSaved(await readFile(file, 'utf8'), () => undefined);
  return result.ok ? result.saved : undefined;
}

export function createJourneyRouter(root = process.cwd()): Router {
  const router = express.Router();
  router.use(express.json({limit: '12mb'}));

  router.get('/journeys', async (_req: Request, res: Response) => {
    res.json(await listJourneys(root));
  });

  router.get('/journeys/:name', async (req: Request, res: Response) => {
    const saved = await loadJourney(root, String(req.params.name));
    if (!saved) {
      res.status(404).json({error: 'No journey by that name.'});
      return;
    }
    res.json(saved);
  });

  router.put('/journeys/:name', async (req: Request, res: Response) => {
    const file = safePath(root, String(req.params.name));
    if (!file) {
      res.status(400).json({error: 'That name cannot be used as a file.'});
      return;
    }
    const saved = req.body as SavedJourney;
    if (!saved?.journey?.nodes) {
      res.status(400).json({error: 'That is not a journey.'});
      return;
    }
    await mkdir(dirFor(root), {recursive: true});
    await writeFile(file, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
    res.json({ok: true, file: path.basename(file)});
  });

  router.delete('/journeys/:name', async (req: Request, res: Response) => {
    const file = safePath(root, String(req.params.name));
    if (!file || !existsSync(file)) {
      res.status(404).json({error: 'No journey by that name.'});
      return;
    }
    await unlink(file);
    res.status(204).end();
  });

  router.get('/journeys/:name/snapshot', async (req: Request, res: Response) => {
    const snapshot = await loadSnapshot(root, String(req.params.name));
    if (!snapshot) {
      res.status(404).json({error: 'Nothing recorded for that journey yet.'});
      return;
    }
    res.json(snapshot);
  });

  router.put('/journeys/:name/snapshot', async (req: Request, res: Response) => {
    const body = req.body as {nodes?: Record<string, Shape>; env?: string; journey?: string};
    if (!body?.nodes || typeof body.nodes !== 'object') {
      res.status(400).json({error: 'No shapes to record.'});
      return;
    }
    const file = await saveSnapshot(root, String(req.params.name), body.nodes, {
      journey: body.journey,
      env: body.env,
    });
    if (!file) {
      res.status(400).json({error: 'That name cannot be used as a file.'});
      return;
    }
    res.json({ok: true, file, nodes: Object.keys(body.nodes).length});
  });

  // Post a finished report to Slack. The webhook lives in config on this side —
  // the browser sends the report, never the credential.
  router.post('/report/slack', async (req: Request, res: Response) => {
    const config = loadConfig(root);
    const webhook = config.slack?.webhookUrl;
    if (!webhook) {
      res.status(400).json({
        error: 'No Slack webhook configured. Add slack.webhookUrl to your config, or set SLACK_WEBHOOK_URL.',
      });
      return;
    }
    const report = (req.body as {report?: QaReport})?.report;
    if (!report?.totals) {
      res.status(400).json({error: 'No report to send.'});
      return;
    }
    res.json(await sendToSlack(webhook, formatReport(report, {title: config.slack?.title})));
  });

  router.get('/report/slack/status', (_req: Request, res: Response) => {
    const config = loadConfig(root);
    res.json({configured: Boolean(config.slack?.webhookUrl)});
  });

  return router;
}
