#!/usr/bin/env node
/**
 * One-way sync: specs/*.md in this repo -> a Notion database.
 * Reconciles the whole specs/ tree on every run (no diffing), keyed by
 * each file's repo-relative path stored in the "File Path" property.
 *
 * Uses Notion's markdown API (Notion-Version 2026-03-11, @notionhq/client
 * >=5.x): pages.create({ markdown }) and pages.updateMarkdown({ type:
 * "replace_content" }) send/replace a page's whole body in a single call,
 * instead of converting to block JSON and paginating list/delete/append.
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("@notionhq/client");

const NOTION_API_KEY = requireEnv("NOTION_API_KEY");
const NOTION_DATA_SOURCE_ID = requireEnv("NOTION_DATA_SOURCE_ID");
const REPO = process.env.GITHUB_REPOSITORY || "";
const BRANCH = process.env.GITHUB_REF_NAME || "main";
const SPECS_DIR = path.join(process.cwd(), "specs");

// Markdown endpoints (pages.create markdown param, pages.updateMarkdown) need
// API version 2026-03-11+; the SDK's own default is older.
const notion = new Client({ auth: NOTION_API_KEY, notionVersion: "2026-03-11" });

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

async function queryAllPages() {
  const pages = [];
  let cursor;
  do {
    const response = await notion.dataSources.query({
      data_source_id: NOTION_DATA_SOURCE_ID,
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

const LEADING_EMOJI = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic})️?\s*/u;

// Repo convention (see specs/example.md): a plain markdown blockquote note
// should render in Notion as a callout, not a quote, picking up a leading
// emoji as its icon (Notion defaults to 💡 when no icon attribute is given).
function convertBlockquotesToCallouts(markdown) {
  const lines = markdown.split("\n");
  const output = [];
  let i = 0;
  while (i < lines.length) {
    if (/^>[ \t]?/.test(lines[i])) {
      const quoteLines = [];
      while (i < lines.length && /^>[ \t]?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>[ \t]?/, ""));
        i++;
      }
      let text = quoteLines.join("<br>");
      let iconAttr = "";
      const match = text.match(LEADING_EMOJI);
      if (match) {
        iconAttr = ` icon="${match[1]}"`;
        text = text.slice(match[0].length);
      }
      output.push(`<callout${iconAttr}>`, `\t${text}`, `</callout>`);
    } else {
      output.push(lines[i]);
      i++;
    }
  }
  return output.join("\n");
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
  const markdown = convertBlockquotesToCallouts(content);
  const properties = buildProperties({ title, relPath, githubUrl, status: "Synced" });

  const existing = existingByPath.get(relPath);
  if (existing) {
    await notion.pages.update({ page_id: existing.id, properties });
    await notion.pages.updateMarkdown({
      page_id: existing.id,
      type: "replace_content",
      replace_content: { new_str: markdown },
    });
    return { relPath, action: "updated" };
  }

  await notion.pages.create({
    parent: { data_source_id: NOTION_DATA_SOURCE_ID },
    properties,
    markdown,
  });
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
  await notion.pages.updateMarkdown({
    page_id: page.id,
    type: "replace_content",
    replace_content: {
      // Wrap the path in backticks so Notion's markdown parser doesn't
      // auto-link a bare "*.md"-looking string.
      new_str: `此規格書（\`${relPath}\`）已從 GitHub repo 中移除或改名，內容不再同步。`,
    },
  });
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
