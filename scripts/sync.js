#!/usr/bin/env node
/**
 * One-way sync: specs/*.md in this repo -> a Notion database.
 * Reconciles the whole specs/ tree on every run (no diffing), keyed by
 * each file's repo-relative path stored in the "File Path" property.
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("@notionhq/client");
const { markdownToBlocks } = require("@tryfabric/martian");

const NOTION_API_KEY = requireEnv("NOTION_API_KEY");
const NOTION_DATABASE_ID = requireEnv("NOTION_DATABASE_ID");
const REPO = process.env.GITHUB_REPOSITORY || "";
const BRANCH = process.env.GITHUB_REF_NAME || "main";
const SPECS_DIR = path.join(process.cwd(), "specs");
const BLOCK_CHUNK_SIZE = 100;

const notion = new Client({ auth: NOTION_API_KEY });

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function relPathOf(absPath) {
  return path.relative(process.cwd(), absPath).split(path.sep).join("/");
}

function extractTitle(content, fallbackName) {
  const match = content.match(/^#\s+(.+)$/m);
  const title = match ? match[1].trim() : fallbackName;
  return title.slice(0, 200);
}

function githubUrlFor(relPath) {
  if (!REPO) return null;
  return `https://github.com/${REPO}/blob/${BRANCH}/${relPath}`;
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function queryAllPages() {
  const pages = [];
  let cursor;
  do {
    const response = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function filePathOf(page) {
  const prop = page.properties?.["File Path"];
  return prop?.rich_text?.[0]?.plain_text ?? null;
}

async function clearChildren(pageId) {
  let cursor;
  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const block of response.results) {
      await notion.blocks.delete({ block_id: block.id });
    }
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
}

async function appendBlocks(pageId, blocks) {
  for (const batch of chunk(blocks, BLOCK_CHUNK_SIZE)) {
    if (batch.length === 0) continue;
    await notion.blocks.children.append({ block_id: pageId, children: batch });
  }
}

const LEADING_EMOJI = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic})️?\s*/u;
const DEFAULT_CALLOUT_ICON = "💡";

function isBlank(richText) {
  return !richText || richText.every((t) => !t.text?.content?.trim());
}

// Markdown blockquotes (`>`) are authored as Notion "callout" blocks, not quote
// blocks: repo convention (see specs/example.md) is a blockquote note, and it
// should render as a callout, picking up a leading emoji as its icon if present.
function convertQuotesToCallouts(blocks) {
  return blocks.map((block) => {
    if (block.type !== "quote") {
      for (const key of Object.keys(block)) {
        const value = block[key];
        if (value && Array.isArray(value.children)) {
          value.children = convertQuotesToCallouts(value.children);
        }
      }
      return block;
    }

    let richText = block.quote.rich_text;
    let children = block.quote.children || [];

    if (isBlank(richText) && children.length === 1 && children[0].type === "paragraph") {
      richText = children[0].paragraph.rich_text;
      children = [];
    }
    children = convertQuotesToCallouts(children);

    let icon = DEFAULT_CALLOUT_ICON;
    if (richText[0]?.text?.content) {
      const match = richText[0].text.content.match(LEADING_EMOJI);
      if (match) {
        icon = match[1];
        richText = [
          { ...richText[0], text: { ...richText[0].text, content: richText[0].text.content.slice(match[0].length) } },
          ...richText.slice(1),
        ];
      }
    }

    const callout = {
      rich_text: richText,
      icon: { type: "emoji", emoji: icon },
      color: block.quote.color || "default",
    };
    if (children.length > 0) callout.children = children;

    return { object: "block", type: "callout", callout };
  });
}

function buildProperties({ title, relPath, githubUrl, status }) {
  const props = {
    Name: { title: [{ text: { content: title } }] },
    "File Path": { rich_text: [{ text: { content: relPath } }] },
    "Last Synced": { date: { start: new Date().toISOString() } },
    Status: { select: { name: status } },
  };
  if (githubUrl) {
    props["GitHub URL"] = { url: githubUrl };
  }
  return props;
}

async function syncFile(file, existingByPath) {
  const relPath = relPathOf(file);
  const content = fs.readFileSync(file, "utf8");
  const title = extractTitle(content, path.basename(file, ".md"));
  const githubUrl = githubUrlFor(relPath);
  const blocks = convertQuotesToCallouts(markdownToBlocks(content));
  const properties = buildProperties({ title, relPath, githubUrl, status: "Synced" });

  const existing = existingByPath.get(relPath);
  if (existing) {
    await notion.pages.update({ page_id: existing.id, properties });
    await clearChildren(existing.id);
    await appendBlocks(existing.id, blocks);
    return { relPath, action: "updated" };
  }

  const firstBatch = blocks.slice(0, BLOCK_CHUNK_SIZE);
  const rest = blocks.slice(BLOCK_CHUNK_SIZE);
  const created = await notion.pages.create({
    parent: { database_id: NOTION_DATABASE_ID },
    properties,
    children: firstBatch,
  });
  if (rest.length > 0) {
    await appendBlocks(created.id, rest);
  }
  return { relPath, action: "created" };
}

async function archivePage(page) {
  const relPath = filePathOf(page);
  const statusName = page.properties?.Status?.select?.name;
  if (statusName === "Archived") {
    return { relPath, action: "skipped-already-archived" };
  }
  await notion.pages.update({
    page_id: page.id,
    properties: {
      Status: { select: { name: "Archived" } },
      "Last Synced": { date: { start: new Date().toISOString() } },
    },
  });
  await clearChildren(page.id);
  await appendBlocks(page.id, [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: `此規格書（${relPath}）已從 GitHub repo 中移除或改名，內容不再同步。`,
            },
          },
        ],
      },
    },
  ]);
  return { relPath, action: "archived" };
}

async function main() {
  const files = listMarkdownFiles(SPECS_DIR);
  const existingPages = await queryAllPages();
  const existingByPath = new Map();
  for (const page of existingPages) {
    const relPath = filePathOf(page);
    if (relPath) existingByPath.set(relPath, page);
  }

  const seen = new Set();
  const results = [];
  for (const file of files) {
    const relPath = relPathOf(file);
    seen.add(relPath);
    results.push(await syncFile(file, existingByPath));
  }

  for (const [relPath, page] of existingByPath) {
    if (!seen.has(relPath)) {
      results.push(await archivePage(page));
    }
  }

  const summary = results.reduce((acc, r) => {
    acc[r.action] = (acc[r.action] || 0) + 1;
    return acc;
  }, {});
  console.log("Sync summary:", summary);
  for (const r of results) {
    console.log(`- [${r.action}] ${r.relPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
