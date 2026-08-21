// ==UserScript==
// @name         AI 对话流转｜ChatGPT 对话导出与整理
// @namespace    local.only.chatgpt.incremental.exporter
// @version      2.9.4
// @description  将 ChatGPT 对话增量同步到本地，支持自动分类、整理和按需提取为 JSON / Markdown。修复 conversations 分页 total 跨页变化兼容性。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document_idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const VERSION = "2.9.4";
  const SCHEMA_VERSION = "2.4";
  const INDEX_SCHEMA_VERSION = "1.0";
  const INACTIVE_DAYS = 7;
  const DAY_MS = 86_400_000;
  const META_DIR = ".chatgpt-export";
  const IDB_NAME = "chatgpt-local-exporter";
  const IDB_STORE = "handles";
  const IDB_HANDLE_KEY = "export-root";
  const IDB_EXTRACT_ENTRY_KEY = "extract-entry";
  const EXTRACT_ENTRY_STATE_KEY = "chatgpt-local-exporter-extract-entry-state-v1";
  const HOST_ID = "chatgpt-local-sync-host";
  const RULES_STORAGE_KEY = "chatgpt-local-exporter-classification-rules-v3";
  const LEGACY_RULES_STORAGE_KEYS = [
    "chatgpt-local-exporter-classification-rules-v2",
    "chatgpt-local-exporter-classification-rules-v1",
  ];
  const CHANGE_MANIFEST_PATH = `${META_DIR}/conversation-changes.json`;
  const SHARED_RULES_PATH = `${META_DIR}/classification-rules.json`;
  const SHARED_RULES_SCHEMA_VERSION = "1.4";
  const CONVERSATION_STATE_PATH = `${META_DIR}/conversation-state.json`;
  const DELETED_CONVERSATIONS_PATH = `${META_DIR}/deleted-conversations.json`;
  const FOLDER_STATE_PATH = `${META_DIR}/folder-state.json`;
  const CONVERSATION_STATE_SCHEMA_VERSION = "1.0";
  const FOLDER_STATE_SCHEMA_VERSION = "1.0";
  const DELETED_CONVERSATIONS_SCHEMA_VERSION = "1.0";
  const KNOWN_AUXILIARY_TYPES = new Set(["thoughts", "reasoning_recap"]);
  const SYSTEM_INBOX_FOLDER = "未归类";
  const SYSTEM_ARCHIVE_FOLDER = "归档";
  const SYSTEM_DELETED_FOLDER = "已删除";
  const EXTRACTION_HISTORY_FOLDER = "提取历史";
  const EXTRACTION_HISTORY_META_DIR = `${META_DIR}/extraction-history`;
  const LEGACY_ARCHIVE_FOLDER = "Archive";
  const LEGACY_DELETED_FOLDER = "Deleted";
  // 正式脚本不内置任何个人分类。用户规则只保存在当前浏览器的 localStorage 中。
  const DEFAULT_CLASSIFICATION_RULES = [];

  function emptyConversationState() {
    return { schema_version: CONVERSATION_STATE_SCHEMA_VERSION, updated_at: null, conversations: {} };
  }

  function emptyDeletedConversations() {
    return { schema_version: DELETED_CONVERSATIONS_SCHEMA_VERSION, updated_at: null, deleted: {} };
  }

  function emptyFolderState() {
    return { schema_version: FOLDER_STATE_SCHEMA_VERSION, updated_at: null, folders: {} };
  }

  function normalizeFolderState(value) {
    const result = emptyFolderState();
    result.updated_at = value?.updated_at || null;
    for (const [path, entry] of Object.entries(value?.folders && typeof value.folders === "object" ? value.folders : {})) {
      const normalizedPath = String(path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
      if (!normalizedPath) continue;
      result.folders[normalizedPath] = {
        json: Boolean(entry?.json),
        markdown: Boolean(entry?.markdown),
        baseline_at: entry?.baseline_at || entry?.updated_at || null,
      };
    }
    return result;
  }

  async function loadFolderState(root) {
    const value = await readJson(root, FOLDER_STATE_PATH);
    if (value === null) return emptyFolderState();
    if (!value?.folders || typeof value.folders !== "object") throw new Error("folder-state.json 格式无效");
    return normalizeFolderState(value);
  }

  async function persistFolderState(root, state) {
    const normalized = normalizeFolderState(state);
    normalized.updated_at = new Date().toISOString();
    await writeJson(root, FOLDER_STATE_PATH, normalized);
    return normalized;
  }

  function normalizeStatePath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  }

  function normalizeStateEntry(entry = {}) {
    const state = ["active", "archived", "deleted"].includes(entry?.state) ? entry.state : "active";
    return {
      title: String(entry?.title || "未命名对话"),
      state,
      last_known: {
        json_path: normalizeStatePath(entry?.last_known?.json_path || entry?.json_path || ""),
        markdown_path: normalizeStatePath(entry?.last_known?.markdown_path || entry?.markdown_path || ""),
      },
      classification: entry?.classification && typeof entry.classification === "object" ? entry.classification : null,
      baseline_at: entry?.baseline_at || entry?.updated_at || null,
    };
  }

  function normalizeConversationState(value) {
    const result = emptyConversationState();
    result.updated_at = value?.updated_at || null;
    for (const [conversationId, entry] of Object.entries(value?.conversations && typeof value.conversations === "object" ? value.conversations : {})) {
      if (!conversationId) continue;
      result.conversations[String(conversationId)] = normalizeStateEntry(entry);
    }
    return result;
  }

  function normalizeDeletedConversations(value) {
    const result = emptyDeletedConversations();
    result.updated_at = value?.updated_at || null;
    for (const [conversationId, entry] of Object.entries(value?.deleted && typeof value.deleted === "object" ? value.deleted : {})) {
      if (!conversationId) continue;
      result.deleted[String(conversationId)] = {
        title: String(entry?.title || "未命名对话"),
        deleted_at: entry?.deleted_at || null,
        source: String(entry?.source || "local"),
      };
    }
    return result;
  }

  async function loadConversationState(root) {
    const value = await readJson(root, CONVERSATION_STATE_PATH);
    if (value === null) return emptyConversationState();
    if (!value?.conversations || typeof value.conversations !== "object") throw new Error("conversation-state.json 格式无效");
    return normalizeConversationState(value);
  }

  async function persistConversationState(root, state) {
    const normalized = normalizeConversationState(state);
    normalized.updated_at = new Date().toISOString();
    await writeJson(root, CONVERSATION_STATE_PATH, normalized);
    return normalized;
  }

  async function loadDeletedConversations(root) {
    const value = await readJson(root, DELETED_CONVERSATIONS_PATH);
    if (value === null) return emptyDeletedConversations();
    if (!value?.deleted || typeof value.deleted !== "object") throw new Error("deleted-conversations.json 格式无效");
    return normalizeDeletedConversations(value);
  }

  async function persistDeletedConversations(root, data) {
    const normalized = normalizeDeletedConversations(data);
    normalized.updated_at = new Date().toISOString();
    await writeJson(root, DELETED_CONVERSATIONS_PATH, normalized);
    return normalized;
  }

  function stateEntryFromIndexEntry(entry, now = new Date().toISOString()) {
    return normalizeStateEntry({
      title: entry?.title || "未命名对话",
      state: "active",
      last_known: {
        json_path: entry?.json_path || "",
        markdown_path: entry?.markdown_path || "",
      },
      classification: entry?.classification || null,
      baseline_at: now,
    });
  }

  function buildObservedConversationMap(observedFiles = []) {
    const result = new Map();
    for (const item of observedFiles) {
      const conversationId = String(item?.conversation_id || "");
      const kind = item?.kind === "JSON" ? "json" : item?.kind === "Markdown" ? "markdown" : "";
      const path = normalizeStatePath(item?.path);
      if (!conversationId || !kind || !path) continue;
      if (!result.has(conversationId)) result.set(conversationId, { json: [], markdown: [] });
      const paths = result.get(conversationId)[kind];
      if (!paths.includes(path)) paths.push(path);
    }
    for (const observed of result.values()) {
      observed.json.sort();
      observed.markdown.sort();
    }
    return result;
  }

  function mirrorKeyForPath(path, kind) {
    let value = normalizeStatePath(path);
    const root = kind === "json" ? "JSON/" : "Markdown/";
    if (value.toLowerCase().startsWith(root.toLowerCase())) value = value.slice(root.length);
    value = kind === "json" ? value.replace(/\.json$/i, "") : value.replace(/\.md$/i, "");
    return value;
  }

  function folderForStatePath(path) {
    const parts = normalizeStatePath(path).split("/").filter(Boolean);
    if (parts.length) parts.shift();
    if (parts.length) parts.pop();
    return parts.join("/");
  }

  function representationChange(kind, previousPath, observedPaths = [], unreadablePaths = new Set()) {
    const from = normalizeStatePath(previousPath);
    const candidates = [...new Set((observedPaths || []).map(normalizeStatePath).filter(Boolean))].sort();
    if (from && unreadablePaths.has(from)) {
      return { kind, type: "uncertain", from, to: null, candidates, reason: "上次位置仍有文件，但当前无法读取 conversation_id" };
    }
    if (candidates.length > 1) {
      return { kind, type: "ambiguous", from, to: null, candidates, reason: "发现多个同 conversation_id 副本" };
    }
    const to = candidates[0] || "";
    if (from === to) return { kind, type: "none", from, to, candidates };
    if (from && !to) return { kind, type: "delete", from, to: "", candidates };
    if (from && to) return { kind, type: "move", from, to, candidates };
    if (!from && to) return { kind, type: "add", from: "", to, candidates };
    return { kind, type: "none", from: "", to: "", candidates };
  }

  function detectConversationChanges(state, observedFiles = [], options = {}) {
    const normalizedState = normalizeConversationState(state);
    const observedById = buildObservedConversationMap(observedFiles);
    const unreadablePaths = new Set((options.unreadableFiles || []).map((item) => normalizeStatePath(item?.path || item)).filter(Boolean));
    const trusted = options.scanTrusted !== false;
    const changes = [];
    if (!trusted) return { trusted: false, changes, reason: "JSON 或 Markdown 根目录未完整扫描，禁止把缺失解释为用户操作" };

    for (const [conversationId, entry] of Object.entries(normalizedState.conversations)) {
      if (entry.state !== "active") continue;
      const observed = observedById.get(conversationId) || { json: [], markdown: [] };
      const json = representationChange("json", entry.last_known.json_path, observed.json, unreadablePaths);
      const markdown = representationChange("markdown", entry.last_known.markdown_path, observed.markdown, unreadablePaths);
      const all = [json, markdown];
      if (all.some((item) => ["ambiguous", "uncertain"].includes(item.type))) {
        changes.push({
          conversation_id: conversationId,
          title: entry.title,
          type: "uncertain",
          state: entry.state,
          representations: all,
          reason: all.filter((item) => ["ambiguous", "uncertain"].includes(item.type)).map((item) => `${item.kind}: ${item.reason}`).join("；"),
        });
        continue;
      }
      const effective = all.filter((item) => item.type !== "none");
      if (!effective.length) continue;
      if (effective.every((item) => item.type === "add")) {
        changes.push({ conversation_id: conversationId, title: entry.title, type: "repair", state: entry.state, representations: all, reason: "原基线缺少路径，本地现已出现文件" });
        continue;
      }
      const targets = effective.map((item) => item.type === "delete" ? "__DELETED__" : mirrorKeyForPath(item.to, item.kind));
      const uniqueTargets = [...new Set(targets)];
      if (uniqueTargets.length === 1) {
        const target = uniqueTargets[0];
        changes.push({
          conversation_id: conversationId,
          title: entry.title,
          type: target === "__DELETED__" ? "delete" : "move",
          state: entry.state,
          target: target === "__DELETED__" ? null : target,
          target_folder: target === "__DELETED__" ? null : folderForStatePath(effective.find((item) => item.to)?.to || ""),
          representations: all,
          reason: effective.length === 1 ? "检测到唯一非零变化向量" : "JSON 与 Markdown 的变化方向一致",
        });
      } else {
        changes.push({
          conversation_id: conversationId,
          title: entry.title,
          type: "conflict",
          state: entry.state,
          representations: all,
          reason: "JSON 与 Markdown 同时发生不同方向的非零变化，需要用户决定最终位置",
        });
      }
    }
    return { trusted: true, changes, reason: "" };
  }

  function extractConversationId(pathname) {
    const match = String(pathname || "").match(/(?:^|\/)c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function toTimestampMs(value) {
    if (value === null || value === undefined || value === "") return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function toIso(value) {
    const ms = toTimestampMs(value);
    return ms ? new Date(ms).toISOString() : null;
  }

  function cleanSegment(value, fallback = "未命名对话") {
    const cleaned = String(value || fallback)
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[\x00-\x1f\x80-\x9f]/g, "_")
      .replace(/[. ]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return (cleaned || fallback).slice(0, 120);
  }

  function shortId(id) {
    const value = String(id || "");
    return value.slice(-6) || "unknown";
  }

  const ILLEGAL_WINDOWS_CHARS = /[\\/:*?"<>|]/;
  const MAX_FOLDER_DEPTH = 12;
  const MAX_RELATIVE_PATH_LENGTH = 240;

  function normalizeDelimiter(value) {
    if (value === null || value === undefined || value === "__unset__") return null;
    return String(value);
  }

  function makeRuleId(seed = "") {
    const safeSeed = String(seed || "").replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return safeSeed
      ? `rule-${safeSeed.toLowerCase()}`
      : `rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function validRuleField(field) {
    const value = String(field || "").trim();
    return /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(value) || /^[\u3400-\u9fff]{1,16}$/.test(value);
  }

  function normalizeAlias(alias) {
    const rawField = String(alias?.field || alias?.prefix || "").trim();
    const field = /^[A-Za-z0-9]+$/.test(rawField) ? rawField.toUpperCase() : rawField;
    const connector = normalizeDelimiter(alias?.connector);
    if (!validRuleField(field) || connector === null) return null;
    return { field, connector };
  }

  function normalizeRule(rule) {
    const rawField = String(rule?.field || rule?.prefix || rule?.code || "").trim();
    const field = /^[A-Za-z0-9]+$/.test(rawField) ? rawField.toUpperCase() : rawField;
    const rootFolder = String(rule?.root_folder || rule?.rootFolder || rule?.folder || "")
      .replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
    if (!validRuleField(field) || !rootFolder) return null;
    const hasConnector = Object.prototype.hasOwnProperty.call(rule || {}, "connector");
    const hasFolderSeparator = Object.prototype.hasOwnProperty.call(rule || {}, "folder_separator")
      || Object.prototype.hasOwnProperty.call(rule || {}, "folderSeparator");
    const legacyFormat = !hasConnector && !hasFolderSeparator;
    const connector = legacyFormat ? null : normalizeDelimiter(rule.connector);
    const folderSeparator = legacyFormat ? null : normalizeDelimiter(rule.folder_separator ?? rule.folderSeparator);
    const hasSubfolderPath = Object.prototype.hasOwnProperty.call(rule || {}, "subfolder_path")
      || Object.prototype.hasOwnProperty.call(rule || {}, "subfolderPath");
    const subfolderPath = folderSeparator === ""
      ? ""
      : String(rule?.subfolder_path ?? rule?.subfolderPath ?? "").trim();
    const subfolderPending = Boolean(rule?.subfolder_pending)
      || (!legacyFormat && folderSeparator !== null && folderSeparator !== "" && !hasSubfolderPath);
    const ruleId = String(rule?.rule_id || rule?.ruleId || makeRuleId(legacyFormat ? `legacy-${field}` : "")).trim();
    const aliases = Array.from(new Map((Array.isArray(rule?.aliases) ? rule.aliases : [])
      .map(normalizeAlias).filter(Boolean)
      .map((alias) => [`${alias.field}\u0000${alias.connector}`, alias])).values());
    return {
      rule_id: ruleId,
      field,
      connector,
      root_folder: rootFolder,
      folder_separator: folderSeparator,
      subfolder_path: subfolderPath,
      subfolder_pending: subfolderPending,
      aliases,
      format_pending: connector === null || folderSeparator === null || subfolderPending,
    };
  }

  function normalizeRules(rules) {
    const result = [];
    const seenIds = new Set();
    const seenFormats = new Set();
    for (const candidate of Array.isArray(rules) ? rules : []) {
      const rule = normalizeRule(candidate);
      if (!rule || seenIds.has(rule.rule_id)) continue;
      const signature = rule.format_pending ? `pending:${rule.field}` : `${rule.field}\u0000${rule.connector}`;
      if (seenFormats.has(signature)) continue;
      seenIds.add(rule.rule_id);
      seenFormats.add(signature);
      result.push(rule);
    }
    return result;
  }

  function delimiterLabel(value, noneLabel = "无") {
    if (value === "") return `[${noneLabel}]`;
    if (value === " ") return "[普通空格]";
    return String(value);
  }

  function ruleFormat(rule) {
    const normalized = normalizeRule(rule);
    if (!normalized || normalized.format_pending) return "格式待确认";
    const connector = delimiterLabel(normalized.connector, "无连接符");
    return `${normalized.field}${connector}{对话名称}`;
  }

  function validatePathPart(value, label) {
    const text = String(value || "");
    if (!text) return `${label}不能为空`;
    if (text !== text.trim()) return `${label}的开头或结尾不能有空格`;
    if (ILLEGAL_WINDOWS_CHARS.test(text)) return `${label}含有 Windows 文件名禁用字符：\\ : * ? " < > |`;
    if (/[. ]$/.test(text)) return `${label}不能以句点或空格结尾`;
    if (text.length > 120) return `${label}超过 120 个字符`;
    return "";
  }

  function validateRule(rule) {
    const normalized = normalizeRule(rule);
    const errors = [];
    if (!normalized) return { ok: false, errors: ["命名标记可使用英文/数字快捷码（1—32 位）或中文（1—16 字），并且一级文件夹不能为空"] };
    if (normalized.connector === null || normalized.folder_separator === null) {
      errors.push("旧规则还没设置完整：请选择命名标记后怎么分隔，以及要不要使用子文件夹");
    }
    if (normalized.subfolder_pending) errors.push("这条旧规则选择了子文件夹，但还没有填写子文件夹名称");
    if (normalized.connector?.includes("\n") || normalized.connector?.includes("\r")) errors.push("分隔符不能包含换行");
    if (normalized.folder_separator?.includes("\n") || normalized.folder_separator?.includes("\r")) errors.push("子文件夹分隔符不能包含换行");
    if (normalized.folder_separator && normalized.folder_separator.length > 4) errors.push("子文件夹分隔符最多 4 个字符");
    if (normalized.connector && normalized.connector.length > 4) errors.push("分隔符最多 4 个字符");
    const rootParts = normalized.root_folder.split("/");
    if (rootParts.some((part) => !part)) errors.push("一级文件夹中存在空文件夹名称");
    for (const [index, part] of rootParts.entries()) {
      const error = validatePathPart(part, `一级文件夹第 ${index + 1} 层`);
      if (error) errors.push(error);
    }
    const subfolders = parseSubfolderPath(normalized);
    if (!subfolders.ok) errors.push(subfolders.error);
    if (rootParts.length + subfolders.parts.length > MAX_FOLDER_DEPTH) errors.push(`文件夹总层级最多 ${MAX_FOLDER_DEPTH} 层`);
    return { ok: errors.length === 0, errors, rule: normalized };
  }

  function parseSubfolderPath(rule) {
    const folderSeparator = normalizeDelimiter(rule?.folder_separator ?? rule?.folderSeparator);
    const subfolderPath = String(rule?.subfolder_path ?? rule?.subfolderPath ?? "").trim();
    if (folderSeparator === null) return { ok: false, parts: [], error: "请选择是否使用子文件夹" };
    if (folderSeparator === "") return { ok: true, parts: [], path: "" };
    if (!subfolderPath) return { ok: false, parts: [], error: "已经选择使用子文件夹，请填写子文件夹名称" };
    const parts = subfolderPath.split(folderSeparator);
    const emptyIndex = parts.findIndex((part) => part === "");
    if (emptyIndex >= 0) {
      const before = parts[emptyIndex - 1] || "开头";
      const after = parts[emptyIndex + 1] || "结尾";
      return { ok: false, parts: [], error: `${before} 和 ${after} 之间存在空文件夹名称` };
    }
    for (const [index, part] of parts.entries()) {
      const error = validatePathPart(part, `子文件夹第 ${index + 1} 层`);
      if (error) return { ok: false, parts: [], error };
    }
    return { ok: true, parts, path: parts.join("/") };
  }

  function parseTitleWithFormat(title, format, rootFolder) {
    const raw = String(title || "");
    const field = String(format.field || "").toUpperCase();
    const connector = normalizeDelimiter(format.connector);
    const folderSeparator = normalizeDelimiter(format.folder_separator);
    if (!raw || !field || connector === null || folderSeparator === null) {
      return { ok: false, code: "format-pending", error: "规则格式待确认" };
    }
    if (raw.slice(0, field.length).toUpperCase() !== field) {
      return { ok: false, code: "field-mismatch", error: `标题不是以识别字段 ${field} 开头` };
    }
    if (raw.slice(field.length, field.length + connector.length) !== connector) {
      return {
        ok: false,
        code: "connector-mismatch",
        error: `识别字段 ${field} 后面应当使用${delimiterLabel(connector, "无连接符")}`,
      };
    }
    const remainder = raw.slice(field.length + connector.length);
    if (!remainder) return { ok: false, code: "missing-title", error: "缺少{对话名称}" };
    if (remainder !== remainder.trim()) {
      return { ok: false, code: "boundary-space", error: "字段连接符之后、对话名称末尾不能再有多余空格" };
    }
    const conversationName = remainder;
    const titleError = validatePathPart(conversationName, "对话名称");
    if (titleError) return { ok: false, code: "invalid-title", error: titleError };
    const subfolders = parseSubfolderPath(format);
    if (!subfolders.ok) return { ok: false, code: "invalid-subfolder", error: subfolders.error };
    const childFolders = subfolders.parts;
    const rootParts = String(rootFolder || "").split("/").filter(Boolean);
    if (rootParts.length + childFolders.length > MAX_FOLDER_DEPTH) {
      return { ok: false, code: "too-deep", error: `文件夹总层级不能超过 ${MAX_FOLDER_DEPTH} 层` };
    }
    const folder = joinPath(rootFolder, ...childFolders);
    const approximatePath = joinPath(folder, `${field}${connector}${conversationName}__唯一ID.json`);
    if (approximatePath.length > MAX_RELATIVE_PATH_LENGTH) {
      return { ok: false, code: "path-too-long", error: `预计相对路径超过 ${MAX_RELATIVE_PATH_LENGTH} 个字符` };
    }
    return { ok: true, field, connector, folder_separator: folderSeparator, child_folders: childFolders, conversation_name: conversationName, folder };
  }

  function parseTitleByRule(title, rule) {
    const normalized = normalizeRule(rule);
    if (!normalized || normalized.format_pending) return { ok: false, code: "format-pending", error: "规则格式待确认" };
    const primary = parseTitleWithFormat(title, normalized, normalized.root_folder);
    if (primary.ok) return { ...primary, rule: normalized, matched_alias: false };
    for (const alias of normalized.aliases) {
      const parsed = parseTitleWithFormat(title, {
        ...alias,
        folder_separator: normalized.folder_separator,
        subfolder_path: normalized.subfolder_path,
      }, normalized.root_folder);
      if (parsed.ok) return { ...parsed, rule: normalized, matched_alias: true };
    }
    return primary;
  }

  function titleHasPrefix(title, prefix, connector = "") {
    return parseTitleWithFormat(title, {
      field: String(prefix || "").trim().toUpperCase(),
      connector,
      folder_separator: "",
      subfolder_path: "",
    }, "_").ok;
  }

  function classifyTitle(title, rules = DEFAULT_CLASSIFICATION_RULES) {
    const candidates = normalizeRules(rules)
      .filter((rule) => !rule.format_pending)
      .sort((a, b) => b.field.length - a.field.length);
    for (const rule of candidates) {
      const parsed = parseTitleByRule(title, rule);
      if (!parsed.ok) continue;
      return {
        kind: "标题规则",
        name: rule.field,
        folder: parsed.folder,
        root_folder: rule.root_folder,
        child_folders: parsed.child_folders,
        conversation_name: parsed.conversation_name,
        file_title: `${parsed.field}${parsed.connector}${parsed.conversation_name}`,
        prefix: rule.field,
        field: rule.field,
        rule_id: rule.rule_id,
        matched_alias: parsed.matched_alias,
        source: "title-format",
      };
    }
    return null;
  }

  function normalizeClassificationOverrides(overrides) {
    const result = {};
    for (const [conversationId, value] of Object.entries(overrides && typeof overrides === "object" ? overrides : {})) {
      const ruleId = String(value?.rule_id || "").trim();
      const folder = String(value?.folder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
      if (!conversationId || (!ruleId && !folder)) continue;
      result[String(conversationId)] = {
        rule_id: ruleId || null,
        folder: folder || null,
        source: ["manual-folder", "manual-folder-direct", "user-selection", "agent"].includes(value?.source) ? value.source : (folder ? "manual-folder-direct" : "manual-folder"),
        updated_at: value?.updated_at || null,
      };
    }
    return result;
  }

  function normalizeIgnoredFolders(folders) {
    return [...new Set((Array.isArray(folders) ? folders : [])
      .map((folder) => String(folder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim())
      .filter(Boolean))].sort();
  }

  function normalizeIgnoredTitleFormats(formats) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(formats) ? formats : []) {
      const field = String(value?.field || "").trim().toUpperCase();
      const connector = normalizeDelimiter(value?.connector);
      if (!field || connector === null) continue;
      const key = `${field}\u0000${connector}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ field, connector });
    }
    return result.sort((a, b) => a.field.localeCompare(b.field) || a.connector.localeCompare(b.connector));
  }

  function ignoredTitleFormatKey(field, connector) {
    return `${String(field || "").trim().toUpperCase()}\u0000${String(connector ?? "")}`;
  }

  function sharedRulesContentSignature(shared) {
    return JSON.stringify({
      rules: normalizeRules(shared?.rules),
      conversation_overrides: normalizeClassificationOverrides(shared?.conversation_overrides),
      ignored_folders: normalizeIgnoredFolders(shared?.ignored_folders),
      ignored_title_formats: normalizeIgnoredTitleFormats(shared?.ignored_title_formats),
    });
  }

  function prepareSharedRulesWrite(current, expected, payload, now = new Date().toISOString()) {
    const currentRevision = Number(current?.revision || 0);
    const expectedRevision = Number(expected?.revision || 0);
    const expectedSignature = String(expected?.signature || "");
    if (currentRevision !== expectedRevision
      || (expectedSignature && sharedRulesContentSignature(current) !== expectedSignature)) {
      throw new Error("共享分类规则已被其他写入者修改。已停止覆盖，请重新扫描并处理差异。");
    }
    return {
      schema_version: SHARED_RULES_SCHEMA_VERSION,
      exporter_version: VERSION,
      revision: currentRevision + 1,
      base_revision: currentRevision,
      updated_at: now,
      updated_by: "browser",
      rules: normalizeRules(payload?.rules),
      conversation_overrides: normalizeClassificationOverrides(payload?.conversation_overrides),
      ignored_folders: normalizeIgnoredFolders(payload?.ignored_folders),
      ignored_title_formats: normalizeIgnoredTitleFormats(payload?.ignored_title_formats),
    };
  }

  function classificationFromRule(rule, title, source = "manual-folder") {
    const normalized = normalizeRule(rule);
    const folder = ruleTargetFolder(normalized);
    if (!normalized || !folder) return null;
    return {
      kind: "标题规则",
      name: normalized.field,
      folder,
      root_folder: normalized.root_folder,
      child_folders: parseSubfolderPath(normalized).parts,
      conversation_name: String(title || "未命名对话"),
      file_title: String(title || "未命名对话"),
      prefix: normalized.field,
      field: normalized.field,
      rule_id: normalized.rule_id,
      matched_alias: false,
      source,
    };
  }

  function joinPath(...parts) {
    return parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/");
  }

  const PINYIN_BOUNDARIES = [
    ["A", "阿"], ["B", "八"], ["C", "嚓"], ["D", "搭"], ["E", "蛾"], ["F", "发"],
    ["G", "噶"], ["H", "哈"], ["J", "击"], ["K", "喀"], ["L", "垃"], ["M", "妈"],
    ["N", "拿"], ["O", "哦"], ["P", "啪"], ["Q", "期"], ["R", "然"], ["S", "撒"],
    ["T", "塌"], ["W", "挖"], ["X", "昔"], ["Y", "压"], ["Z", "匝"],
  ];

  function pinyinInitial(character) {
    if (/^[A-Za-z]$/.test(character)) return character.toUpperCase();
    if (/^[0-9]$/.test(character)) return character;
    if (!/[\u3400-\u9fff]/.test(character)) return "";
    try {
      const collator = new Intl.Collator("zh-CN-u-co-pinyin");
      let initial = "";
      for (const [letter, boundary] of PINYIN_BOUNDARIES) {
        if (collator.compare(character, boundary) >= 0) initial = letter;
        else break;
      }
      return initial;
    } catch {
      return "";
    }
  }

  function suggestRuleField(folderName) {
    const suggestion = Array.from(String(folderName || ""))
      .map((character) => pinyinInitial(character))
      .join("")
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 32);
    if (!suggestion) return "";
    return /^[A-Z]/.test(suggestion) ? suggestion : `F${suggestion}`.slice(0, 32);
  }

  function folderRuleDraft(relativeFolder) {
    const parts = String(relativeFolder || "").replace(/\\/g, "/").split("/").filter(Boolean);
    const rootFolder = parts[0] || "";
    const childFolders = parts.slice(1);
    return {
      path: parts.join("/"),
      root_folder: rootFolder,
      child_folders: childFolders,
      folder_separator: childFolders.length ? "/" : "",
      subfolder_path: childFolders.join("/"),
      suggested_field: suggestRuleField(parts.at(-1) || rootFolder),
    };
  }

  function ruleTargetFolder(rule) {
    const normalized = normalizeRule(rule);
    if (!normalized) return "";
    const parsed = parseSubfolderPath(normalized);
    return parsed.ok ? joinPath(normalized.root_folder, ...parsed.parts) : normalized.root_folder;
  }

  function buildFolderAudit(inventory, rules = []) {
    const folders = {
      JSON: new Set(inventory?.folders?.JSON || []),
      Markdown: new Set(inventory?.folders?.Markdown || []),
    };
    const files = {
      JSON: new Set(inventory?.files?.JSON || []),
      Markdown: new Set(inventory?.files?.Markdown || []),
    };
    const onlyJsonFolders = [...folders.JSON].filter((folder) => !folders.Markdown.has(folder)).sort();
    const onlyMarkdownFolders = [...folders.Markdown].filter((folder) => !folders.JSON.has(folder)).sort();
    const ruleTargets = normalizeRules(rules).map(ruleTargetFolder).filter(Boolean);
    const targetSet = new Set(ruleTargets);
    const missingRuleTargets = [...new Set(ruleTargets)]
      .filter((folder) => !folders.JSON.has(folder) || !folders.Markdown.has(folder))
      .sort();

    const makeFileMap = (entries, extension) => {
      const map = new Map();
      for (const path of entries) {
        const parts = String(path).split("/");
        const filename = parts.pop() || "";
        const stem = filename.replace(extension, "");
        if (!map.has(stem)) map.set(stem, []);
        map.get(stem).push({ path, folder: parts.join("/") });
      }
      return map;
    };
    const jsonMap = makeFileMap(files.JSON, /\.json$/i);
    const markdownMap = makeFileMap(files.Markdown, /\.md$/i);
    const jsonWithoutMarkdown = [...jsonMap.keys()].filter((stem) => !markdownMap.has(stem)).sort();
    const markdownWithoutJson = [...markdownMap.keys()].filter((stem) => !jsonMap.has(stem)).sort();
    const pathMismatches = [];
    for (const stem of [...jsonMap.keys()].filter((name) => markdownMap.has(name))) {
      const jsonFolders = new Set(jsonMap.get(stem).map((item) => item.folder));
      const markdownFolders = new Set(markdownMap.get(stem).map((item) => item.folder));
      if (![...jsonFolders].some((folder) => markdownFolders.has(folder))) {
        pathMismatches.push({
          stem,
          json_paths: jsonMap.get(stem).map((item) => item.path),
          markdown_paths: markdownMap.get(stem).map((item) => item.path),
        });
      }
    }

    const allFolders = [...new Set([...folders.JSON, ...folders.Markdown])].sort();
    const hasDirectFile = (folder) => [...files.JSON, ...files.Markdown]
      .some((path) => path.split("/").slice(0, -1).join("/") === folder);
    const unregisteredFolders = allFolders
      .filter((folder) => {
        if (!folder || folder === "未归类" || targetSet.has(folder)) return false;
        const hasChild = allFolders.some((candidate) => candidate.startsWith(`${folder}/`));
        const oneSided = !folders.JSON.has(folder) || !folders.Markdown.has(folder);
        return !hasChild || hasDirectFile(folder);
      })
      .map((folder) => ({
        ...folderRuleDraft(folder),
        present_in: [
          ...(folders.JSON.has(folder) ? ["JSON"] : []),
          ...(folders.Markdown.has(folder) ? ["Markdown"] : []),
        ],
      }));
    return {
      folders: { JSON: [...folders.JSON].sort(), Markdown: [...folders.Markdown].sort() },
      files: { JSON: [...files.JSON].sort(), Markdown: [...files.Markdown].sort() },
      onlyJsonFolders, onlyMarkdownFolders, missingRuleTargets,
      jsonWithoutMarkdown, markdownWithoutJson, pathMismatches, unregisteredFolders,
      hasDrift: Boolean(
        onlyJsonFolders.length || onlyMarkdownFolders.length || missingRuleTargets.length
        || jsonWithoutMarkdown.length || markdownWithoutJson.length
        || pathMismatches.length || unregisteredFolders.length
      ),
    };
  }

  function folderTreeHasContent(audit, kind, folderPath) {
    const folder = String(folderPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!folder) return true;
    const folders = audit?.folders?.[kind] || [];
    const files = audit?.files?.[kind] || [];
    return folders.some((path) => path.startsWith(`${folder}/`))
      || files.some((path) => path === folder || path.startsWith(`${folder}/`));
  }

  function folderSnapshotFromAudit(audit, now = new Date().toISOString()) {
    const result = emptyFolderState();
    const json = new Set(audit?.folders?.JSON || []);
    const markdown = new Set(audit?.folders?.Markdown || []);
    for (const path of [...new Set([...json, ...markdown])].sort()) {
      result.folders[path] = { json: json.has(path), markdown: markdown.has(path), baseline_at: now };
    }
    result.updated_at = now;
    return result;
  }

  function detectFolderChanges(folderState, audit, rules = []) {
    const state = normalizeFolderState(folderState);
    const json = new Set(audit?.folders?.JSON || []);
    const markdown = new Set(audit?.folders?.Markdown || []);
    const managed = new Set([SYSTEM_INBOX_FOLDER, ...normalizeRules(rules).map(ruleTargetFolder).filter(Boolean)]);
    const allPaths = [...new Set([...Object.keys(state.folders), ...json, ...markdown])].sort();
    const changes = [];
    for (const folder of allPaths) {
      const hasJson = json.has(folder);
      const hasMarkdown = markdown.has(folder);
      if (hasJson === hasMarkdown) continue;
      const presentKind = hasJson ? "JSON" : "Markdown";
      const missingKind = hasJson ? "Markdown" : "JSON";
      const previous = state.folders[folder] || null;
      if (managed.has(folder)) {
        changes.push({
          type: "create-mirror", folder, create_in: missingKind, present_in: presentKind, managed: true,
          reason: "这是系统目录或已经登记的分类，两边都应该存在",
        });
        continue;
      }
      // 目录里还有文件/子目录时，不让“空目录逻辑”介入；Conversation 自己的移动/删除逻辑优先。
      if (folderTreeHasContent(audit, presentKind, folder)) continue;
      const previouslyPaired = Boolean(previous?.json && previous?.markdown);
      // 普通空目录只有一边时，不替用户猜“这是新建还是删除”。
      // 给两个明确动作：删掉剩下的空目录，或者把缺的一边补回来。
      changes.push({
        type: "decide-empty-folder",
        folder,
        present_in: presentKind,
        missing_in: missingKind,
        previously_paired: previouslyPaired,
        suggested_action: previouslyPaired ? "delete" : "mirror",
        reason: previouslyPaired
          ? "这个空目录上次两边都有，现在只剩一边"
          : "这个空目录现在只在一边存在，没有可靠历史可以判断你是新建还是删除",
      });
    }
    return { trusted: true, changes };
  }

  function conversationIdsInFolder(observedFiles = [], folderPath = "") {
    const folder = String(folderPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const result = new Set();
    for (const item of observedFiles || []) {
      const path = normalizeStatePath(item?.path);
      const parts = path.split("/").filter(Boolean);
      if (parts.length < 2) continue;
      parts.shift();
      parts.pop();
      if (parts.join("/") === folder && item?.conversation_id) result.add(String(item.conversation_id));
    }
    return [...result];
  }

  function buildConversationIssues(index, observedFiles = [], rules = [], overrides = {}) {
    const observedById = new Map();
    for (const item of observedFiles) {
      const conversationId = String(item?.conversation_id || "");
      const kind = item?.kind === "Markdown" ? "markdown" : item?.kind === "JSON" ? "json" : "";
      const path = String(item?.path || "");
      if (!conversationId || !kind || !path) continue;
      if (!observedById.has(conversationId)) observedById.set(conversationId, { json: [], markdown: [] });
      const paths = observedById.get(conversationId)[kind];
      if (!paths.includes(path)) paths.push(path);
    }
    const entries = index?.conversations && typeof index.conversations === "object" ? index.conversations : {};
    const conversationIds = new Set([...Object.keys(entries), ...observedById.keys()]);
    const issues = [];
    for (const conversationId of conversationIds) {
      const entry = entries[conversationId] || { conversation_id: conversationId, title: "索引外对话" };
      const observed = observedById.get(conversationId) || { json: [], markdown: [] };
      observed.json.sort();
      observed.markdown.sort();
      const classification = detectClassification(
        { id: conversationId, title: entry.title },
        { id: conversationId, title: entry.title },
        rules, overrides,
      ) || entry.classification || null;
      const desired = classificationHasExplicitTarget(classification)
        ? archivePaths(entry.title, conversationId, classification)
        : null;
      const types = [];
      if (!observed.json.length) types.push("missing-json");
      if (!observed.markdown.length) types.push("missing-markdown");
      if (observed.json.length > 1) types.push("duplicate-json");
      if (observed.markdown.length > 1) types.push("duplicate-markdown");
      const jsonFolders = new Set(observed.json.map((path) => path.split("/").slice(1, -1).join("/")));
      const markdownFolders = new Set(observed.markdown.map((path) => path.split("/").slice(1, -1).join("/")));
      if (observed.json.length && observed.markdown.length
        && ![...jsonFolders].some((folder) => markdownFolders.has(folder))) types.push("split-folders");
      if ((observed.json.length && !observed.json.includes(entry.json_path))
        || (observed.markdown.length && !observed.markdown.includes(entry.markdown_path))) types.push("index-drift");
      // “未归类”是合法收件箱状态，不再作为异常。
      if (desired && ((observed.json.length && !observed.json.includes(desired.json))
        || (observed.markdown.length && !observed.markdown.includes(desired.markdown)))) types.push("wrong-target");
      if (!types.length) continue;
      issues.push({
        conversation_id: conversationId,
        title: entry.title || "未命名对话",
        types: [...new Set(types)],
        json_paths: observed.json,
        markdown_paths: observed.markdown,
        indexed_json: entry.json_path || null,
        indexed_markdown: entry.markdown_path || null,
        classification,
        desired_paths: desired,
      });
    }
    return issues.sort((a, b) => a.title.localeCompare(b.title, "zh-CN") || a.conversation_id.localeCompare(b.conversation_id));
  }

  function partToText(part, depth = 0) {
    if (depth > 8 || part === null || part === undefined) return "";
    if (["string", "number", "boolean"].includes(typeof part)) return String(part);
    if (Array.isArray(part)) return part.map((item) => partToText(item, depth + 1)).filter(Boolean).join("\n");
    if (typeof part !== "object") return "";
    for (const key of ["text", "content", "caption", "result", "output", "value", "transcript", "code"]) {
      if (typeof part[key] === "string" && part[key].trim()) return part[key];
    }
    for (const key of ["parts", "content", "result", "output", "items"]) {
      if (part[key] && typeof part[key] === "object") {
        const nested = partToText(part[key], depth + 1);
        if (nested) return nested;
      }
    }
    const pointer = part.asset_pointer || part.file_id || part.image_url || part.url || "";
    const kind = part.content_type || part.type || "attachment";
    return pointer ? `[${kind}: ${pointer}]` : "";
  }

  function contentToText(content) {
    return partToText(content).trim();
  }

  function hasMeaningfulRawContent(value, depth = 0) {
    if (depth > 8 || value === null || value === undefined) return false;
    if (typeof value === "string") return Boolean(value.trim());
    if (["number", "boolean"].includes(typeof value)) return true;
    if (Array.isArray(value)) return value.some((item) => hasMeaningfulRawContent(item, depth + 1));
    if (typeof value !== "object") return false;
    return Object.entries(value).some(([key, item]) => {
      if (["content_type", "type"].includes(key) && typeof item === "string") return false;
      return hasMeaningfulRawContent(item, depth + 1);
    });
  }

  function collectFiles(message) {
    const candidateFiles = [];
    const metadata = message?.metadata || {};
    for (const key of ["attachments", "files", "file_ids", "content_references"]) {
      const value = metadata[key];
      if (Array.isArray(value)) candidateFiles.push(...value);
      else if (value) candidateFiles.push(value);
    }
    const seen = new Set();
    return candidateFiles.map((item) => {
      const obj = item && typeof item === "object" ? item : { id: String(item) };
      return {
        id: obj.id || obj.file_id || obj.asset_pointer || null,
        name: obj.name || obj.filename || null,
        mime_type: obj.mime_type || obj.type || null,
        size: obj.size || obj.size_bytes || null,
      };
    }).filter((file) => {
      const key = JSON.stringify(file);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function getActiveBranch(conversation) {
    const mapping = conversation?.mapping;
    if (!mapping || typeof mapping !== "object" || !Object.keys(mapping).length) {
      throw new Error("接口返回内容缺少有效 mapping");
    }
    let nodeId = conversation.current_node;
    if (!nodeId || !mapping[nodeId]) throw new Error("current_node 缺失或不在 mapping 中");
    const reverse = [];
    const seen = new Set();
    while (nodeId) {
      if (seen.has(nodeId)) throw new Error(`父链循环：${nodeId}`);
      seen.add(nodeId);
      const node = mapping[nodeId];
      if (!node) throw new Error(`父链断裂：${nodeId}`);
      reverse.push(node);
      if (!node.parent) break;
      if (!mapping[node.parent]) throw new Error(`父节点不存在：${node.parent}`);
      nodeId = node.parent;
    }
    return reverse.reverse();
  }

  function normalizeMessageNode(node, warnings) {
    const message = node?.message;
    const role = message?.author?.role;
    if (!message || !["user", "assistant", "system", "tool"].includes(role)) return null;
    const text = contentToText(message.content);
    const files = collectFiles(message);
    const contentType = message.content?.content_type || message.content?.type || "unknown";
    if (!text && !files.length) {
      if (!KNOWN_AUXILIARY_TYPES.has(contentType) && hasMeaningfulRawContent(message.content)) {
        warnings.push(`节点 ${node.id || message.id || "unknown"} 的内容结构无法转换：${contentType}`);
      }
      return null;
    }
    return {
      message_id: String(node.id || message.id || ""),
      role,
      occurred_at: toIso(message.create_time),
      content: text,
      files,
      model: message.metadata?.model_slug || null,
    };
  }

  function allMessageNodesByTime(conversation) {
    return Object.entries(conversation?.mapping || {}).map(([id, node]) => ({ ...(node || {}), id: node?.id || id }))
      .filter((node) => node?.message)
      .sort((a, b) => {
        const time = toTimestampMs(a.message?.create_time) - toTimestampMs(b.message?.create_time);
        return time || String(a.id).localeCompare(String(b.id));
      });
  }

  function normalizeMessages(conversation) {
    const warnings = [];
    const normalizedMessages = [];
    let nodes;
    let mode = "active-branch";
    try {
      const mappingValidation = validateMapping(conversation?.mapping || {});
      if (!mappingValidation.ok) {
        nodes = allMessageNodesByTime(conversation);
        mode = "all-nodes-time-order";
        warnings.push(`mapping 引用不完整，已忽略父子关系并按时间保存全部可读消息：${mappingValidation.errors.slice(0, 8).join("；")}`);
      } else {
        nodes = getActiveBranch(conversation);
      }
    } catch (error) {
      nodes = allMessageNodesByTime(conversation);
      mode = "all-nodes-time-order";
      warnings.push(`mapping 父子链不可用，已忽略父子关系并按时间保存全部可读消息：${error.message}`);
    }
    const seen = new Set();
    for (const node of nodes) {
      const normalized = normalizeMessageNode(node, warnings);
      if (!normalized || !normalized.message_id || seen.has(normalized.message_id)) continue;
      seen.add(normalized.message_id);
      normalizedMessages.push(normalized);
    }
    return { messages: normalizedMessages, warnings, mode };
  }

  function detectClassification(item, conversation, rules = DEFAULT_CLASSIFICATION_RULES, overrides = {}) {
    const conversationId = String(conversation?.id || item?.id || item?.conversation_id || "");
    const override = normalizeClassificationOverrides(overrides)[conversationId];
    if (override?.folder) {
      const parts = override.folder.split("/").filter(Boolean);
      const title = conversation?.title || item?.title || "未命名对话";
      return {
        kind: "本地目录", name: parts.at(-1) || override.folder, folder: override.folder,
        root_folder: parts[0] || "", child_folders: parts.slice(1), conversation_name: title,
        file_title: title, prefix: "", field: "", rule_id: null, matched_alias: false,
        source: "manual-folder-direct",
      };
    }
    if (override?.rule_id) {
      const rule = normalizeRules(rules).find((candidate) => candidate.rule_id === override.rule_id);
      const manual = classificationFromRule(rule, conversation?.title || item?.title || "", "manual-folder");
      if (manual) return manual;
    }
    const fromTitle = classifyTitle(conversation?.title || item?.title || "", rules);
    if (fromTitle) return fromTitle;
    const projectId = item?.project_id || conversation?.project_id;
    const projectTitle = item?.project_title || item?.project_name || conversation?.project_title;
    if (projectId && projectTitle) return { kind: "项目", name: cleanSegment(projectTitle) };
    const gizmoId = item?.gizmo_id || conversation?.gizmo_id;
    const gizmoName = item?.gizmo_name || item?.gpt_name || conversation?.gizmo_name;
    if (gizmoId && gizmoName) return { kind: "自定义GPT", name: cleanSegment(gizmoName) };
    return { kind: "未归类", name: "", source: "none" };
  }

  function archivePaths(title, conversationId, classification) {
    const stemTitle = classification?.file_title || title;
    const stem = `${cleanSegment(stemTitle)}__${shortId(conversationId)}`;
    const subdir = classification?.folder
      ? classification.folder.split("/").filter(Boolean).map((part) => cleanSegment(part)).join("/")
      : classification.kind === "未归类"
      ? classification.kind
      : joinPath(classification.kind, classification.name);
    return {
      json: joinPath("JSON", subdir, `${stem}.json`),
      markdown: joinPath("Markdown", subdir, `${stem}.md`),
    };
  }

  function buildArchive(conversation, inventoryItem = {}, rules = DEFAULT_CLASSIFICATION_RULES, overrides = {}) {
    const conversationId = String(conversation.id || inventoryItem.id || "");
    if (!conversationId) throw new Error("完整对话数据缺少 conversation_id");
    const normalized = normalizeMessages(conversation);
    const title = conversation.title || inventoryItem.title || "未命名对话";
    const classification = detectClassification(inventoryItem, conversation, rules, overrides);
    return {
      schema_version: SCHEMA_VERSION,
      exporter_version: VERSION,
      conversation_id: conversationId,
      title,
      create_time: toIso(conversation.create_time || inventoryItem.create_time),
      update_time: toIso(conversation.update_time || inventoryItem.update_time),
      classification,
      messages: normalized.messages,
      raw: { mapping: conversation.mapping, current_node: conversation.current_node },
      normalization_mode: normalized.mode,
      conversion_warnings: normalized.warnings,
    };
  }

  function isEmptyReplacement(value) {
    return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
  }

  function fileIdentity(file) {
    return String(file?.id || file?.file_id || file?.asset_pointer || JSON.stringify(file));
  }

  function mergeFiles(oldFiles, newFiles) {
    const merged = new Map();
    for (const file of [...(oldFiles || []), ...(newFiles || [])]) {
      if (!file) continue;
      const key = fileIdentity(file);
      merged.set(key, { ...(merged.get(key) || {}), ...file });
    }
    return Array.from(merged.values());
  }

  function orderedUnion(oldItems, newItems) {
    return Array.from(new Set([...(oldItems || []), ...(newItems || [])]));
  }

  function mergeAdditive(oldValue, newValue, key = "") {
    if (isEmptyReplacement(newValue) && !isEmptyReplacement(oldValue)) return oldValue;
    if (oldValue === undefined || oldValue === null) return newValue;
    if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      if (key === "children") return orderedUnion(oldValue, newValue);
      if (["files", "attachments", "content_references"].includes(key)) return mergeFiles(oldValue, newValue);
      return newValue.length >= oldValue.length ? newValue : oldValue;
    }
    if (typeof oldValue === "object" && typeof newValue === "object" && !Array.isArray(oldValue) && !Array.isArray(newValue)) {
      const merged = { ...oldValue };
      for (const [childKey, value] of Object.entries(newValue)) merged[childKey] = mergeAdditive(oldValue[childKey], value, childKey);
      return merged;
    }
    return newValue;
  }

  function validateMapping(mapping) {
    const errors = [];
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      return { ok: false, errors: ["mapping 不是对象"], roots: [], reachable: [] };
    }
    const entries = Object.entries(mapping);
    const roots = entries.filter(([, node]) => !node?.parent).map(([id]) => id);
    if (!roots.length && entries.length) errors.push("mapping 没有根节点");
    for (const [id, node] of entries) {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        errors.push(`${id} 的 mapping 节点不是对象`);
        continue;
      }
      if (node.parent && !mapping[node.parent]) errors.push(`${id} 的 parent ${node.parent} 不存在`);
      if (node.children !== undefined && node.children !== null && !Array.isArray(node.children)) {
        errors.push(`${id} 的 children 不是数组`);
        continue;
      }
      for (const child of node.children || []) {
        if (!mapping[child]) errors.push(`${id} 的 child ${child} 不存在`);
        else if (mapping[child]?.parent && mapping[child].parent !== id) errors.push(`${id} 与 child ${child} 的 parent 引用不一致`);
      }
    }
    const reachable = new Set();
    const pendingIds = [...roots];
    for (let cursor = pendingIds.length - 1; cursor >= 0; cursor = pendingIds.length - 1) {
      const id = pendingIds.pop();
      if (reachable.has(id) || !mapping[id] || typeof mapping[id] !== "object") continue;
      reachable.add(id);
      const children = Array.isArray(mapping[id].children) ? mapping[id].children : [];
      for (const child of children) if (mapping[child]) pendingIds.push(child);
    }
    for (const [id] of entries) if (!reachable.has(id)) errors.push(`${id} 无法从根节点到达`);
    return { ok: errors.length === 0, errors, roots, reachable: Array.from(reachable) };
  }

  function mergeMappingsConservatively(oldMappingInput, newMappingInput) {
    const warnings = [];
    const oldMapping = oldMappingInput && typeof oldMappingInput === "object" && !Array.isArray(oldMappingInput) ? oldMappingInput : {};
    const newMapping = newMappingInput && typeof newMappingInput === "object" && !Array.isArray(newMappingInput) ? newMappingInput : {};
    if (oldMappingInput && oldMapping !== oldMappingInput) warnings.push("旧 mapping 不是对象，已忽略无法安全解释的容器值");
    if (newMappingInput && newMapping !== newMappingInput) warnings.push("最新 mapping 不是对象，已忽略无法安全解释的容器值");

    const oldIds = Object.keys(oldMapping);
    const newIds = Object.keys(newMapping);
    const allIds = orderedUnion(newIds, oldIds);
    const preservedNodeIds = oldIds.filter((id) => !Object.prototype.hasOwnProperty.call(newMapping, id));
    const merged = {};
    const hasNodeObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

    for (const id of allIds) {
      const oldNode = oldMapping[id];
      const newNode = newMapping[id];
      let node;
      if (hasNodeObject(oldNode) && hasNodeObject(newNode)) node = mergeAdditive(oldNode, newNode);
      else if (hasNodeObject(newNode)) node = { ...newNode };
      else if (hasNodeObject(oldNode)) node = { ...oldNode };
      else {
        node = { id, parent: null, children: [] };
        warnings.push(`mapping 节点 ${id} 不是可合并对象，已保留为最小节点并标记警告`);
      }
      merged[id] = node;
    }

    const hasId = (id) => Boolean(id && Object.prototype.hasOwnProperty.call(merged, id));
    const normalizeRef = (value) => {
      if (value === undefined || value === null || value === "") return "";
      return String(value);
    };
    const childrenFor = (mapping, label) => {
      const result = new Map();
      for (const id of allIds) {
        const node = mapping[id];
        if (!hasNodeObject(node) || node.children === undefined || node.children === null) {
          result.set(id, []);
          continue;
        }
        if (!Array.isArray(node.children)) {
          warnings.push(`${label} mapping 节点 ${id} 的 children 不是数组，已忽略该关系`);
          result.set(id, []);
          continue;
        }
        const list = [];
        for (const rawChild of node.children) {
          const child = normalizeRef(rawChild);
          if (!child || child === id) {
            if (child === id) warnings.push(`${label} mapping 节点 ${id} 包含自引用 child，已忽略`);
            continue;
          }
          if (!hasId(child)) {
            warnings.push(`${label} mapping 节点 ${id} 的 child ${child} 不存在，已忽略该损坏引用`);
            continue;
          }
          if (!list.includes(child)) list.push(child);
        }
        result.set(id, list);
      }
      return result;
    };

    const oldChildren = childrenFor(oldMapping, "旧");
    const newChildren = childrenFor(newMapping, "最新");
    const reverseParents = (childrenMap) => {
      const reverse = new Map();
      for (const [parentId, children] of childrenMap.entries()) {
        for (const childId of children) {
          if (!reverse.has(childId)) reverse.set(childId, []);
          reverse.get(childId).push(parentId);
        }
      }
      return reverse;
    };
    const oldChildParents = reverseParents(oldChildren);
    const newChildParents = reverseParents(newChildren);
    const parents = {};
    let usedOldFallback = false;

    for (const id of allIds) {
      const newParent = normalizeRef(newMapping[id]?.parent);
      const oldParent = normalizeRef(oldMapping[id]?.parent);
      let chosen = "";
      if (newParent) {
        if (newParent !== id && hasId(newParent)) chosen = newParent;
        else warnings.push(`最新 mapping 节点 ${id} 的 parent ${newParent} 无效，不用它覆盖旧关系`);
      }
      if (!chosen && oldParent && oldParent !== id && hasId(oldParent)) {
        chosen = oldParent;
        if (newParent || Object.prototype.hasOwnProperty.call(newMapping, id)) usedOldFallback = true;
      }
      if (!chosen && oldParent && (oldParent === id || !hasId(oldParent))) {
        warnings.push(`旧 mapping 节点 ${id} 的 parent ${oldParent} 无效，已停止传播该损坏关系`);
      }
      if (!chosen) {
        const latestRefs = newChildParents.get(id) || [];
        const oldRefs = oldChildParents.get(id) || [];
        if (latestRefs.length === 1) {
          chosen = latestRefs[0];
          if (!newParent) warnings.push(`最新 mapping 节点 ${id} 缺少 parent，已从 children 关系推定为 ${chosen}`);
        } else if (latestRefs.length > 1) {
          warnings.push(`最新 mapping 节点 ${id} 同时被多个 parent 引用，无法安全推定 parent`);
        } else if (oldRefs.length === 1) {
          chosen = oldRefs[0];
          if (Object.prototype.hasOwnProperty.call(newMapping, id)) usedOldFallback = true;
        } else if (oldRefs.length > 1) {
          warnings.push(`旧 mapping 节点 ${id} 同时被多个 parent 引用，仅保留节点数据并标记警告`);
        }
      }
      parents[id] = chosen || null;
    }

    const findParentCycle = () => {
      const complete = new Set();
      for (const start of allIds) {
        const localIndex = new Map();
        const path = [];
        let current = start;
        while (current && parents[current]) {
          if (localIndex.has(current)) return path.slice(localIndex.get(current));
          if (complete.has(current)) break;
          localIndex.set(current, path.length);
          path.push(current);
          current = parents[current];
        }
        for (const id of path) complete.add(id);
      }
      return null;
    };

    for (let guard = 0; guard <= allIds.length; guard++) {
      const cycle = findParentCycle();
      if (!cycle) break;
      let repaired = false;
      for (const id of cycle) {
        const oldParent = normalizeRef(oldMapping[id]?.parent);
        if (oldParent && oldParent !== id && hasId(oldParent) && oldParent !== parents[id] && !cycle.includes(oldParent)) {
          warnings.push(`mapping parent 出现循环，节点 ${id} 已回退到旧 parent ${oldParent}`);
          parents[id] = oldParent;
          usedOldFallback = true;
          repaired = true;
          break;
        }
      }
      if (!repaired) {
        const id = cycle[0];
        warnings.push(`mapping parent 出现无法可靠回退的循环，已保留节点 ${id} 但清除该 parent 关系`);
        parents[id] = null;
      }
    }

    const children = {};
    for (const id of allIds) children[id] = orderedUnion(newChildren.get(id) || [], oldChildren.get(id) || []);
    const mergedChildParents = reverseParents(new Map(allIds.map((id) => [id, children[id] || []])));
    for (const childId of allIds) {
      const parentId = parents[childId];
      if (!parentId) continue;
      for (const candidateParent of mergedChildParents.get(childId) || []) {
        if (candidateParent === parentId) continue;
        children[candidateParent] = (children[candidateParent] || []).filter((id) => id !== childId);
      }
      if (!children[parentId].includes(childId)) children[parentId].push(childId);
    }

    for (const id of allIds) {
      merged[id] = {
        ...merged[id],
        parent: parents[id],
        children: children[id] || [],
      };
    }

    const validation = validateMapping(merged);
    if (!validation.ok) warnings.push(`合并后 mapping 仍有结构警告：${validation.errors.slice(0, 8).join("；")}`);
    const repaired = warnings.length > 0 || usedOldFallback;
    if (preservedNodeIds.length) {
      warnings.push(`mapping 合并保留了 ${preservedNodeIds.length} 个最新响应中缺失的旧节点：${preservedNodeIds.slice(0, 8).join("、")}${preservedNodeIds.length > 8 ? "…" : ""}`);
    }
    return {
      mapping: merged, validation, warnings, preservedNodeIds, usedOldFallback,
      mode: preservedNodeIds.length
        ? (repaired ? "conservative-node-union-preserved-repaired" : "conservative-node-union-preserved")
        : (repaired ? "conservative-node-union-repaired" : "conservative-node-union"),
    };
  }

  function mergeArchives(oldArchive, newArchive) {
    if (!oldArchive) return { archive: newArchive, preserved: false };
    const oldMapping = oldArchive.raw?.mapping || {};
    const newMapping = newArchive.raw?.mapping || {};
    const oldMessages = oldArchive.messages || [];
    const newMessages = newArchive.messages || [];
    const messageMap = new Map(oldMessages.map((message) => [String(message.message_id), message]));
    for (const message of newMessages) {
      const id = String(message.message_id);
      const previous = messageMap.get(id);
      const merged = mergeAdditive(previous || {}, message);
      merged.files = mergeFiles(previous?.files, message.files);
      messageMap.set(id, merged);
    }
    const messages = Array.from(messageMap.values()).sort((a, b) => {
      const time = toTimestampMs(a.occurred_at) - toTimestampMs(b.occurred_at);
      return time || String(a.message_id).localeCompare(String(b.message_id));
    });

    const oldValidation = validateMapping(oldMapping);
    const newValidation = validateMapping(newMapping);
    const mappingWarnings = [];
    if (!oldValidation.ok && Object.keys(oldMapping).length) mappingWarnings.push(`旧 mapping 结构异常：${oldValidation.errors.slice(0, 8).join("；")}`);
    if (!newValidation.ok && Object.keys(newMapping).length) mappingWarnings.push(`最新 mapping 结构异常：${newValidation.errors.slice(0, 8).join("；")}`);

    const mappingMerge = mergeMappingsConservatively(oldMapping, newMapping);
    const mergedMapping = mappingMerge.mapping;
    const currentWarnings = [];
    const newCurrent = String(newArchive.raw?.current_node || "");
    const oldCurrent = String(oldArchive.raw?.current_node || "");
    let currentNode = null;
    if (newCurrent && Object.prototype.hasOwnProperty.call(mergedMapping, newCurrent)) currentNode = newCurrent;
    else {
      if (newCurrent) currentWarnings.push(`最新 current_node ${newCurrent} 不在合并后 mapping 中，已尝试回退旧 current_node`);
      if (oldCurrent && Object.prototype.hasOwnProperty.call(mergedMapping, oldCurrent)) currentNode = oldCurrent;
    }
    if (!currentNode && Object.keys(mergedMapping).length) currentWarnings.push("合并后 mapping 没有可用 current_node，已写入 null 并保留警告");

    const preserved = mappingMerge.preservedNodeIds.length > 0
      || newMessages.length < oldMessages.length
      || mappingMerge.usedOldFallback;
    const mergeMode = mappingMerge.validation.ok
      ? "message-union-conservative-mapping"
      : "message-union-invalid-mapping-preserved";
    return {
      preserved,
      archive: {
        ...oldArchive,
        ...newArchive,
        create_time: oldArchive.create_time || newArchive.create_time,
        update_time: toTimestampMs(newArchive.update_time) >= toTimestampMs(oldArchive.update_time)
          ? newArchive.update_time : oldArchive.update_time,
        messages,
        raw: {
          mapping: mergedMapping,
          current_node: currentNode,
        },
        previous_raw_summary: {
          node_count: Object.keys(oldMapping).length,
          current_node: oldArchive.raw?.current_node || null,
          update_time: oldArchive.update_time || null,
        },
        merge_mode: mergeMode,
        mapping_merge_mode: mappingMerge.mode,
        mapping_validation: mappingMerge.validation,
        conversion_warnings: Array.from(new Set([
          ...(oldArchive.conversion_warnings || []),
          ...(newArchive.conversion_warnings || []),
          ...mappingWarnings,
          ...mappingMerge.warnings,
          ...currentWarnings,
        ])),
      },
    };
  }

  function computeSyncPlan(remoteItems, localEntries, now = Date.now(), rules = null, overrides = null) {
    const cutoff = now - INACTIVE_DAYS * DAY_MS;
    const local = localEntries || {};
    const plan = { active: [], add: [], update: [], skip: [], unknown: [] };
    for (const item of remoteItems) {
      const existing = local[item.id];
      const updateMs = toTimestampMs(item.update_time || item.updateTimeMs);
      const isActive = Boolean(updateMs && updateMs >= cutoff);
      const isNew = !existing;
      const localUpdateMs = toTimestampMs(existing?.update_time);
      const isUpdated = Boolean(existing && updateMs && updateMs > localUpdateMs);
      const isRenamed = Boolean(existing && item.title && item.title !== existing.title);
      const desiredClassification = existing && rules
        ? detectClassification(item, { id: item.id, title: item.title }, rules, overrides || {})
        : null;
      const desiredPaths = desiredClassification ? archivePaths(item.title, item.id, desiredClassification) : null;
      const isRuleReclassified = Boolean(existing && desiredPaths && (
        desiredPaths.json !== existing.json_path
        || desiredPaths.markdown !== existing.markdown_path
        || desiredClassification.rule_id !== existing.classification?.rule_id
      ));
      const enriched = { ...item, updateTimeMs: updateMs, isActive, reason: "" };
      if (!updateMs) plan.unknown.push(enriched);
      if (isNew) {
        enriched.reason = "本地缺少";
        plan.add.push(enriched);
      } else if (isUpdated || isRenamed || isRuleReclassified) {
        enriched.reason = isRuleReclassified && !isUpdated && !isRenamed
          ? "分类规则或目标文件夹已修改"
          : isRenamed && !isUpdated ? "网页端标题已修改" : "网页端已更新";
        plan.update.push(enriched);
      } else {
        enriched.reason = updateMs ? "更新时间未变化" : "更新时间未知，本地已有";
        plan.skip.push(enriched);
      }
      if (isActive) plan.active.push(enriched);
    }
    const queue = [];
    const seen = new Set();
    const needed = [...plan.add, ...plan.update];
    for (const group of [needed.filter((item) => item.isActive), needed.filter((item) => !item.isActive)]) {
      for (const item of group) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          queue.push(item);
        }
      }
    }
    return { ...plan, queue, localCount: Object.keys(local).length };
  }

  function previewText(value, limit = 100) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  function timelineFromArchives(archives) {
    const byId = new Map();
    for (const archive of archives) {
      const sourcePath = archive._json_path || "";
      for (const message of archive.messages || []) {
        const id = String(message.message_id || "");
        if (!id) continue;
        byId.set(id, {
          occurred_at: message.occurred_at,
          conversation_id: archive.conversation_id,
          conversation_title: archive.title,
          message_id: id,
          role: message.role,
          preview: previewText(message.content),
          source_path: sourcePath,
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) => {
      const time = toTimestampMs(a.occurred_at) - toTimestampMs(b.occurred_at);
      return time || a.message_id.localeCompare(b.message_id);
    });
  }

  function pendingPath(conversationId) {
    return `${META_DIR}/pending/${cleanSegment(conversationId, "unknown")}.json`;
  }

  function recoveryPath(conversationId, now = Date.now()) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    return `${META_DIR}/recovery/${cleanSegment(conversationId, "unknown")}__${stamp}.json`;
  }

  function createExportRevision() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function createPendingCommit(conversationId, paths, updateTime, messageCount, exportRevision) {
    return {
      schema_version: "1.0", conversation_id: conversationId,
      export_revision: exportRevision, expected_update_time: updateTime || null,
      expected_message_count: Number(messageCount || 0),
      json_path: paths.json, markdown_path: paths.markdown,
      stage: "prepared", started_at: new Date().toISOString(),
    };
  }

  function parseMarkdownMetadata(text) {
    const source = String(text || "");
    if (!source.startsWith("---\n")) throw new Error("Markdown YAML 头缺失");
    const end = source.indexOf("\n---", 4);
    if (end < 0) throw new Error("Markdown YAML 头未闭合");
    const meta = {};
    for (const line of source.slice(4, end).split(/\r?\n/)) {
      const match = line.match(/^([a-z_]+):\s*(.*)$/i);
      if (!match) continue;
      meta[match[1]] = match[2].replace(/^"|"$/g, "");
    }
    meta.message_count = Number(meta.message_count);
    return meta;
  }

  function assessPendingCommit(record, state) {
    const errors = [...(state.errors || [])];
    const json = state.jsonArchive;
    const markdown = state.markdownMeta;
    const index = state.indexEntry;
    const expectedTime = String(record.expected_update_time || "");
    const expectedCount = Number(record.expected_message_count || 0);
    if (!json) errors.push("JSON 缺失、损坏或读取失败");
    if (!markdown) errors.push("Markdown 缺失、损坏或读取失败");
    if (!index) errors.push("索引条目缺失或读取失败");
    const check = (source, label) => {
      if (!source) return;
      if (String(source.conversation_id || "") !== String(record.conversation_id)) errors.push(`${label} conversation_id 不一致`);
      if (String(source.export_revision || "") !== String(record.export_revision)) errors.push(`${label} export_revision 不一致`);
      if (String(source.update_time || "") !== expectedTime) errors.push(`${label} update_time 不一致`);
      const count = label === "JSON" ? source.messages?.length : source.message_count;
      if (Number(count) !== expectedCount) errors.push(`${label} message_count 不一致`);
      if (label === "JSON" && source.json_path && source.json_path !== record.json_path) errors.push("JSON 路径不一致");
      if (label === "Markdown" && source.markdown_path && source.markdown_path !== record.markdown_path) errors.push("Markdown 路径不一致");
      if (label === "索引" && (source.json_path !== record.json_path || source.markdown_path !== record.markdown_path)) errors.push("索引路径不一致");
    };
    check(json, "JSON");
    check(markdown, "Markdown");
    check(index, "索引");
    return { complete: errors.length === 0, errors };
  }

  function classificationHasExplicitTarget(classification) {
    return Boolean(
      classification?.folder
      && ["title-format", "manual-folder", "manual-folder-direct", "user-selection"].includes(classification.source),
    );
  }

  async function assertRelocationTargetSafe(io, path, conversationId, kind) {
    if (!io.exists || !(await io.exists(path))) return;
    let targetId = "";
    try {
      if (kind === "JSON") targetId = String((await io.readJson(path))?.conversation_id || "");
      else targetId = String(parseMarkdownMetadata(await io.readText(path))?.conversation_id || "");
    } catch (error) {
      throw new Error(`目标 ${kind} 已存在但无法验证，禁止覆盖：${path}（${error.message}）`);
    }
    if (targetId !== String(conversationId)) {
      throw new Error(`目标 ${kind} 属于其他对话，禁止覆盖：${path}`);
    }
  }

  async function stageConversationWrite({ io, freshArchive, oldEntry, markdownText, now = Date.now(), exportRevision = createExportRevision() }) {
    const writeRecovery = async (originalPath, error) => {
      const recovery = recoveryPath(freshArchive.conversation_id, now);
      await io.writeJson(recovery, freshArchive);
      return {
        kind: "recovery", partial: true, recovery_path: recovery,
        original_path: originalPath, parse_error: error.message || String(error),
        conversation_id: freshArchive.conversation_id,
      };
    };
    let oldArchive = null;
    if (oldEntry?.json_path) {
      try {
        oldArchive = await io.readJson(oldEntry.json_path);
        if (!oldArchive?.conversation_id) throw new Error("缺少 conversation_id");
      } catch (error) {
        return writeRecovery(oldEntry.json_path, error);
      }
    }
    const merged = mergeArchives(oldArchive, freshArchive);
    const archive = merged.archive;
    const desiredPaths = archivePaths(archive.title, archive.conversation_id, archive.classification);
    const explicitRelocation = Boolean(
      oldEntry?.json_path
      && oldEntry?.markdown_path
      && classificationHasExplicitTarget(archive.classification)
      && (oldEntry.json_path !== desiredPaths.json || oldEntry.markdown_path !== desiredPaths.markdown),
    );
    const paths = explicitRelocation
      ? desiredPaths
      : oldEntry?.json_path && oldEntry?.markdown_path
        ? { json: oldEntry.json_path, markdown: oldEntry.markdown_path }
        : desiredPaths;
    if (explicitRelocation) {
      if (paths.json !== oldEntry.json_path) await assertRelocationTargetSafe(io, paths.json, archive.conversation_id, "JSON");
      if (paths.markdown !== oldEntry.markdown_path) await assertRelocationTargetSafe(io, paths.markdown, archive.conversation_id, "Markdown");
    }
    if (!oldEntry && io.exists && await io.exists(paths.json)) {
      return writeRecovery(paths.json, new Error("目标 JSON 已存在但不在可用索引中，禁止覆盖"));
    }
    archive.json_path = paths.json;
    archive.markdown_path = paths.markdown;
    archive.export_revision = exportRevision;
    const pending = createPendingCommit(archive.conversation_id, paths, archive.update_time, archive.messages.length, exportRevision);
    const pendingFile = pendingPath(archive.conversation_id);
    await io.writeJson(pendingFile, pending);
    await io.writeJson(paths.json, archive);
    pending.stage = "json_written";
    await io.writeJson(pendingFile, pending);
    await io.writeText(paths.markdown, markdownText(archive));
    pending.stage = "markdown_written";
    await io.writeJson(pendingFile, pending);
    return {
      kind: "staged", archive, paths, pending, pending_path: pendingFile, preserved: merged.preserved,
      relocated_from: explicitRelocation
        ? { json: oldEntry.json_path, markdown: oldEntry.markdown_path }
        : null,
    };
  }

  function indexEntryFromArchive(archive, paths = { json: archive.json_path, markdown: archive.markdown_path }) {
    return {
      conversation_id: archive.conversation_id, title: archive.title,
      create_time: archive.create_time, update_time: archive.update_time,
      message_count: archive.messages?.length || 0, export_revision: archive.export_revision,
      json_path: paths.json, markdown_path: paths.markdown,
      classification: archive.classification || { kind: "未归类", name: "" },
    };
  }

  async function recoverPendingCommit({ io, pendingFile, record, index, renderMarkdown, persistIndex }) {
    const errors = [];
    let jsonArchive = null;
    let markdownMeta = null;
    try { jsonArchive = await io.readJson(record.json_path); }
    catch (error) { errors.push(`JSON 读取失败：${error.message}`); }
    try { markdownMeta = parseMarkdownMetadata(await io.readText(record.markdown_path)); }
    catch (error) { errors.push(`Markdown 读取失败：${error.message}`); }
    let assessment = assessPendingCommit(record, {
      jsonArchive, markdownMeta, indexEntry: index.conversations[record.conversation_id], errors,
    });
    if (!assessment.complete) {
      const jsonOnly = assessPendingCommit(record, { jsonArchive, markdownMeta: null, indexEntry: null });
      const jsonValid = jsonArchive && !jsonOnly.errors.some((error) => error.startsWith("JSON "));
      if (!jsonValid) return { complete: false, repaired: false, errors: assessment.errors };
      try {
        await io.writeText(record.markdown_path, renderMarkdown(jsonArchive));
        record.stage = "markdown_written";
        await io.writeJson(pendingFile, record);
        index.conversations[record.conversation_id] = indexEntryFromArchive(jsonArchive, { json: record.json_path, markdown: record.markdown_path });
        await persistIndex(index);
        record.stage = "index_written";
        await io.writeJson(pendingFile, record);
        const verifiedJson = await io.readJson(record.json_path);
        const verifiedMarkdown = parseMarkdownMetadata(await io.readText(record.markdown_path));
        assessment = assessPendingCommit(record, {
          jsonArchive: verifiedJson, markdownMeta: verifiedMarkdown,
          indexEntry: index.conversations[record.conversation_id],
        });
      } catch (error) {
        return { complete: false, repaired: false, errors: [...assessment.errors, `恢复失败：${error.message}`] };
      }
    }
    if (!assessment.complete) return { complete: false, repaired: false, errors: assessment.errors };
    record.stage = "committed";
    await io.writeJson(pendingFile, record);
    await io.remove(pendingFile);
    return { complete: true, repaired: true, errors: [] };
  }

  async function loadOrRebuildIndex({ load, rebuild }) {
    try {
      const index = await load();
      if (index?.conversations && typeof index.conversations === "object") {
        return { index, rebuilt: false, persisted: true, issues: [] };
      }
    } catch { /* rebuild below */ }
    const result = await rebuild();
    if (!result?.index?.conversations || result.persisted === false) throw new Error("索引重建或持久化失败");
    return { ...result, rebuilt: true, persisted: true };
  }

  function syncState({ written = 0, failures = [], stageFailures = [], cancelled = false, recoveries = [] }) {
    const safelyWritten = written + recoveries.length;
    if (!safelyWritten && (failures.length || stageFailures.length || cancelled)) return "同步失败";
    if (failures.length || stageFailures.length || cancelled || recoveries.length) return "部分同步";
    return "完整同步";
  }

  function validatePaginationCount(actual, total) {
    if (total !== null && total !== undefined && actual !== total) {
      throw new Error(`目录分页不完整：接口 total=${total}，实际读取=${actual}`);
    }
    return true;
  }

  async function fetchAllPages({ fetchPage, limit = 100, maxItems = 10000, maxPasses = 4 }) {
    const idOf = (item) => String(item?.id || item?.conversation_id || "");
    const sameIdSet = (a, b) => {
      if (!a || !b || a.size !== b.size) return false;
      for (const id of a) if (!b.has(id)) return false;
      return true;
    };

    const scanOnce = async () => {
      const items = [];
      const seenIds = new Set();
      const duplicateIds = new Set();
      const reportedTotals = [];
      let pageCount = 0;
      let paginationComplete = false;

      for (let offset = 0; offset < maxItems; offset += limit) {
        const page = await fetchPage({ offset, limit });
        if (!page || !Array.isArray(page.items)) throw new Error(`分页不完整：分页 ${offset} 缺少 items`);
        pageCount += 1;

        const pageTotal = Number.isFinite(Number(page.total)) ? Number(page.total) : null;
        if (pageTotal !== null) reportedTotals.push(pageTotal);

        for (const item of page.items) {
          const id = idOf(item);
          if (!id) throw new Error(`分页不完整：分页 ${offset} 存在缺少 conversation_id 的条目`);
          if (seenIds.has(id)) {
            duplicateIds.add(id);
            continue;
          }
          seenIds.add(id);
          items.push(item);
        }

        // ChatGPT 当前 conversations 接口的 total 已观察到会跨页变化。
        // 因此 total 只作为诊断信息，不参与结束条件；实际短页才表示扫描到底。
        if (page.items.length < limit) {
          paginationComplete = true;
          break;
        }
      }

      if (!paginationComplete) {
        throw new Error(`分页不完整：超过安全上限 ${maxItems}，为避免漏导出已停止`);
      }

      return {
        items,
        ids: seenIds,
        duplicateIds,
        pageCount,
        reportedTotals,
        reportedTotal: reportedTotals.length ? reportedTotals[reportedTotals.length - 1] : null,
      };
    };

    let previousStable = null;
    let lastReason = "";

    for (let pass = 1; pass <= maxPasses; pass += 1) {
      const current = await scanOnce();

      if (current.duplicateIds.size) {
        previousStable = null;
        lastReason = `第 ${pass} 次扫描发现 ${current.duplicateIds.size} 个重复对话`;
        continue;
      }

      // 单页目录不存在 offset 翻页位移风险，直接接受实际读取结果。
      if (current.pageCount === 1) {
        return {
          items: current.items,
          total: current.items.length,
          reportedTotal: current.reportedTotal,
          reportedTotals: current.reportedTotals,
          paginationComplete: true,
        };
      }

      // 多页目录至少需要两次稳定扫描得到相同 Conversation ID 集合。
      // 这样既允许服务器 total 漂移，也不会因为放宽 total 校验而静默漏页。
      if (previousStable && sameIdSet(previousStable.ids, current.ids)) {
        return {
          items: current.items,
          total: current.items.length,
          reportedTotal: current.reportedTotal,
          reportedTotals: current.reportedTotals,
          paginationComplete: true,
        };
      }

      lastReason = previousStable
        ? `第 ${pass - 1} / ${pass} 次扫描的对话集合不一致`
        : `第 ${pass} 次扫描需要稳定性复核`;
      previousStable = current;
    }

    throw new Error(`分页不完整：目录在扫描期间持续变化（${lastReason || "未取得稳定快照"}），请稍后重试`);
  }

  function computeCanSync({ directoryPermission, sessionOk, interfaceOk, paginationComplete, indexUsable, rebuildOk, indexPersisted }) {
    return Boolean(directoryPermission && sessionOk && interfaceOk && paginationComplete && indexUsable && rebuildOk && indexPersisted);
  }

  async function runQueue(items, worker, shouldCancel = () => false) {
    const successes = [];
    const failures = [];
    let cancelled = false;
    for (const item of items) {
      if (shouldCancel()) {
        cancelled = true;
        break;
      }
      try { successes.push(await worker(item)); }
      catch (error) { failures.push({ id: item.id, reason: error.message || String(error) }); }
    }
    return { successes, failures, cancelled };
  }

  async function executeSyncWorkflow({
    items, shouldCancel = () => false, processItem, applyIndex,
    persistIndex, finalizeCommit, writeTimeline, writeHistory, writeReport, onProgress = () => {},
  }) {
    let position = 0;
    const queue = await runQueue(items, async (item) => {
      onProgress(++position, items.length, item);
      const result = await processItem(item);
      if (result?.kind === "staged") applyIndex(result);
      return result;
    }, shouldCancel);
    const staged = queue.successes.filter((item) => item?.kind === "staged");
    const recoveries = queue.successes.filter((item) => item?.kind === "recovery");
    const stageFailures = [];
    let indexPersisted = false;
    try {
      await persistIndex();
      indexPersisted = true;
      for (const item of staged) await finalizeCommit(item);
    } catch (error) {
      stageFailures.push({ stage: "conversation-index", reason: error.message || String(error) });
    }
    if (indexPersisted) {
      try { await writeTimeline(); }
      catch (error) { stageFailures.push({ stage: "timeline", reason: error.message || String(error) }); }
    }
    const snapshot = () => ({
      written: staged.length, failures: queue.failures, recoveries, stageFailures,
      cancelled: queue.cancelled,
      state: syncState({ written: staged.length, failures: queue.failures, recoveries, stageFailures, cancelled: queue.cancelled }),
    });
    try { await writeHistory(snapshot()); }
    catch (error) { stageFailures.push({ stage: "sync-history", reason: error.message || String(error) }); }
    try { await writeReport(snapshot()); }
    catch (error) {
      stageFailures.push({ stage: "last-report", reason: error.message || String(error) });
      try { await writeHistory(snapshot()); } catch { /* 首次 history 结果已单独计入 */ }
    }
    return snapshot();
  }


  function extractionFolderFromEntry(entry = {}) {
    const path = normalizeStatePath(entry.json_path || entry.markdown_path || "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length) parts.shift();
    if (parts.length) parts.pop();
    return parts.join("/");
  }

  function extractionFieldFromEntry(entry = {}) {
    const classification = entry.classification || {};
    return String(classification.field || classification.prefix || (classification.kind === "标题规则" ? classification.name : "") || "").trim();
  }

  function normalizeExtractionOptions(options = {}) {
    const days = Number(options.days || 0);
    return {
      days: Number.isFinite(days) && days > 0 ? days : 0,
      start: String(options.start || "").trim(),
      end: String(options.end || "").trim(),
      field: String(options.field || "").trim(),
      folder: String(options.folder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim(),
      include_subfolders: options.include_subfolders !== false,
      keyword: String(options.keyword || "").trim().toLowerCase(),
    };
  }

  function filterExtractionEntries(indexOrEntries, options = {}, now = Date.now()) {
    const normalized = normalizeExtractionOptions(options);
    const source = Array.isArray(indexOrEntries)
      ? indexOrEntries
      : Object.values(indexOrEntries?.conversations && typeof indexOrEntries.conversations === "object" ? indexOrEntries.conversations : indexOrEntries || {});
    const startMs = normalized.start ? Date.parse(`${normalized.start}T00:00:00`) : 0;
    const endMs = normalized.end ? Date.parse(`${normalized.end}T23:59:59.999`) : 0;
    const cutoff = normalized.days ? now - normalized.days * DAY_MS : 0;
    return source.filter((entry) => {
      if (!entry?.conversation_id) return false;
      const updateMs = toTimestampMs(entry.update_time || entry.create_time);
      if (cutoff && (!updateMs || updateMs < cutoff)) return false;
      if (startMs && (!updateMs || updateMs < startMs)) return false;
      if (endMs && (!updateMs || updateMs > endMs)) return false;
      if (normalized.field && extractionFieldFromEntry(entry).toUpperCase() !== normalized.field.toUpperCase()) return false;
      const folder = extractionFolderFromEntry(entry);
      if (normalized.folder) {
        const matches = folder === normalized.folder || (normalized.include_subfolders && folder.startsWith(`${normalized.folder}/`));
        if (!matches) return false;
      }
      if (normalized.keyword) {
        const haystack = `${entry.title || ""}\n${entry.conversation_id || ""}`.toLowerCase();
        if (!haystack.includes(normalized.keyword)) return false;
      }
      return true;
    }).sort((a, b) => toTimestampMs(b.update_time || b.create_time) - toTimestampMs(a.update_time || a.create_time)
      || String(a.title || "").localeCompare(String(b.title || "")));
  }

  function utf8Bytes(value) {
    return new TextEncoder().encode(String(value ?? ""));
  }

  let CRC32_TABLE = null;
  function crc32(bytes) {
    if (!CRC32_TABLE) {
      CRC32_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        CRC32_TABLE[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
  }

  function le16(value) {
    return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
  }

  function le32(value) {
    return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }

  function zipDosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    const dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
    return { dosTime, dosDate };
  }

  function createStoreZip(entries = [], date = new Date()) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const { dosTime, dosDate } = zipDosDateTime(date);
    for (const entry of entries) {
      const nameBytes = utf8Bytes(String(entry.name || "").replace(/\\/g, "/").replace(/^\/+/, ""));
      const data = entry.data instanceof Uint8Array ? entry.data : utf8Bytes(entry.data);
      const crc = crc32(data);
      const flags = 0x0800;
      const local = concatBytes([
        le32(0x04034b50), le16(20), le16(flags), le16(0), le16(dosTime), le16(dosDate),
        le32(crc), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), nameBytes, data,
      ]);
      localParts.push(local);
      const central = concatBytes([
        le32(0x02014b50), le16(20), le16(20), le16(flags), le16(0), le16(dosTime), le16(dosDate),
        le32(crc), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), le16(0),
        le16(0), le16(0), le32(0), le32(offset), nameBytes,
      ]);
      centralParts.push(central);
      offset += local.length;
    }
    const central = concatBytes(centralParts);
    const eocd = concatBytes([
      le32(0x06054b50), le16(0), le16(0), le16(entries.length), le16(entries.length), le32(central.length), le32(offset), le16(0),
    ]);
    return concatBytes([...localParts, central, eocd]);
  }

  function validatePlatformAdapter(adapter) {
    const required = ["id", "displayName", "matches", "getConversationId", "getSession", "fetchInventory", "fetchConversation"];
    const missing = required.filter((key) => {
      if (["id", "displayName"].includes(key)) return typeof adapter?.[key] !== "string" || !adapter[key].trim();
      return typeof adapter?.[key] !== "function";
    });
    return { ok: missing.length === 0, missing };
  }

  const Core = {
    extractConversationId, toTimestampMs, toIso, cleanSegment, computeSyncPlan,
    mergeArchives, mergeFiles, validateMapping, mergeMappingsConservatively, timelineFromArchives, normalizeMessages, archivePaths,
    normalizeRule, normalizeRules, validateRule, parseSubfolderPath, delimiterLabel, ruleFormat, parseTitleWithFormat,
    parseTitleByRule, titleHasPrefix, classifyTitle, detectClassification, buildArchive,
    pinyinInitial, suggestRuleField, folderRuleDraft, ruleTargetFolder, buildFolderAudit, buildConversationIssues,
    normalizeClassificationOverrides, normalizeIgnoredFolders, normalizeIgnoredTitleFormats, sharedRulesContentSignature, prepareSharedRulesWrite, classificationFromRule,
    pendingPath, recoveryPath, createPendingCommit, assessPendingCommit, classificationHasExplicitTarget, stageConversationWrite,
    createExportRevision, parseMarkdownMetadata, recoverPendingCommit, indexEntryFromArchive,
    loadOrRebuildIndex, syncState, validatePaginationCount, fetchAllPages, computeCanSync, runQueue, executeSyncWorkflow,
    validatePlatformAdapter,
    emptyConversationState, normalizeConversationState, emptyDeletedConversations, normalizeDeletedConversations, emptyFolderState, normalizeFolderState,
    stateEntryFromIndexEntry, buildObservedConversationMap, mirrorKeyForPath, representationChange, detectConversationChanges,
    loadConversationState, persistConversationState, loadDeletedConversations, persistDeletedConversations, loadFolderState, persistFolderState,
    folderTreeHasContent, folderSnapshotFromAudit, detectFolderChanges, conversationIdsInFolder, conversationIdsDirectlyInFolder,
    validRuleField, extractionFolderFromEntry, extractionFieldFromEntry, normalizeExtractionOptions, filterExtractionEntries,
    uniqueFlatExtractionName, collectDirectoryFilesFlat, copyDirectoryContentsFlat,
    crc32, createStoreZip,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = Core;
  if (typeof window === "undefined" || typeof document === "undefined") return;

  let ui = null;
  let running = false;
  let cancelRequested = false;
  let cachedDirectoryHandle = null;
  let directoryHandleLoaded = false;
  let classificationRules = loadClassificationRules();
  let classificationOverrides = {};
  let ignoredFolders = [];
  let ignoredRemoteTitleFormats = [];
  let sharedRulesBase = { revision: 0, signature: "" };

  function loadClassificationRules() {
    try {
      const currentText = localStorage.getItem(RULES_STORAGE_KEY);
      if (currentText !== null) return normalizeRules(JSON.parse(currentText));
      const legacyText = LEGACY_RULES_STORAGE_KEYS
        .map((key) => localStorage.getItem(key))
        .find((text) => text !== null);
      const legacyRules = legacyText != null ? JSON.parse(legacyText) : DEFAULT_CLASSIFICATION_RULES;
      const pendingRules = normalizeRules(legacyRules);
      localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(pendingRules));
      return pendingRules;
    } catch { /* use defaults */ }
    return normalizeRules(DEFAULT_CLASSIFICATION_RULES);
  }

  function saveClassificationRules(rules) {
    classificationRules = normalizeRules(rules);
    localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(classificationRules));
    renderClassificationRules();
  }

  async function readSharedClassificationRules(root, { create = true } = {}) {
    const shared = await readJson(root, SHARED_RULES_PATH);
    if (shared && Array.isArray(shared.rules)) {
      const rules = normalizeRules(shared.rules);
      classificationOverrides = normalizeClassificationOverrides(shared.conversation_overrides);
      ignoredFolders = normalizeIgnoredFolders(shared.ignored_folders);
      ignoredRemoteTitleFormats = normalizeIgnoredTitleFormats(shared.ignored_title_formats);
      sharedRulesBase = {
        revision: Number(shared.revision || 0),
        signature: sharedRulesContentSignature(shared),
      };
      saveClassificationRules(rules);
      return { rules, overrides: classificationOverrides, source: "shared-file" };
    }
    if (create) {
      sharedRulesBase = { revision: 0, signature: "" };
      const rules = normalizeRules(classificationRules);
      const created = prepareSharedRulesWrite(null, sharedRulesBase, {
        rules, conversation_overrides: classificationOverrides, ignored_folders: ignoredFolders,
        ignored_title_formats: ignoredRemoteTitleFormats,
      });
      await writeJson(root, SHARED_RULES_PATH, created);
      sharedRulesBase = { revision: created.revision, signature: sharedRulesContentSignature(created) };
      return { rules, overrides: classificationOverrides, source: "created-from-browser-rules" };
    }
    return { rules: classificationRules, overrides: classificationOverrides, source: "browser-rules" };
  }

  async function writeSharedClassificationRules(root) {
    const current = await readJson(root, SHARED_RULES_PATH);
    const next = prepareSharedRulesWrite(current, sharedRulesBase, {
      rules: classificationRules,
      conversation_overrides: classificationOverrides,
      ignored_folders: ignoredFolders,
      ignored_title_formats: ignoredRemoteTitleFormats,
    });
    if (current) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await writeJson(root, `${META_DIR}/backups/classification-rules-r${Number(current.revision || 0)}__${stamp}.json`, current);
    }
    await writeJson(root, SHARED_RULES_PATH, next);
    const verified = await readJson(root, SHARED_RULES_PATH);
    if (Number(verified?.revision || 0) !== next.revision
      || sharedRulesContentSignature(verified) !== sharedRulesContentSignature(next)) {
      throw new Error("共享分类规则写入后校验失败，已保留上一版备份。");
    }
    sharedRulesBase = { revision: next.revision, signature: sharedRulesContentSignature(next) };
  }

  async function readObservedFileIdentity(handle, kind, path) {
    const file = await handle.getFile();
    const head = await file.slice(0, Math.min(file.size, 65_536)).text();
    let conversationId = "";
    if (kind === "JSON") {
      conversationId = head.match(/"conversation_id"\s*:\s*"([^"]+)"/)?.[1] || "";
      if (!conversationId && file.size > head.length) {
        const data = JSON.parse(await file.text());
        conversationId = String(data?.conversation_id || "");
      }
    } else {
      conversationId = String(parseMarkdownMetadata(head)?.conversation_id || "");
    }
    return conversationId ? { conversation_id: conversationId, kind, path: joinPath(kind, path) } : null;
  }

  async function conversationIdsDirectlyInFolder(root, folderPath) {
    const folder = String(folderPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const ids = new Set();
    if (!folder) return [];
    for (const kind of ["JSON", "Markdown"]) {
      try {
        const directory = await getDirectory(root, joinPath(kind, folder), false);
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind !== "file") continue;
          if (kind === "JSON" && !/\.json$/i.test(name)) continue;
          if (kind === "Markdown" && !/\.md$/i.test(name)) continue;
          try {
            const observed = await readObservedFileIdentity(handle, kind, joinPath(folder, name));
            if (observed?.conversation_id) ids.add(String(observed.conversation_id));
          } catch { /* 单个异常文件不阻止登记其他正常对话 */ }
        }
      } catch (error) {
        if (error?.name !== "NotFoundError") throw error;
      }
    }
    return [...ids];
  }

  async function auditExportFolders(root, onProgress = () => {}) {
    const inventory = {
      folders: { JSON: new Set(), Markdown: new Set() },
      files: { JSON: new Set(), Markdown: new Set() },
    };
    const observedFiles = [];
    const unreadableFiles = [];
    const unreadableEntries = [];
    const rootsPresent = { JSON: false, Markdown: false };
    let scannedFiles = 0;
    const scan = async (directory, kind, prefix = "") => {
      for await (const [name, handle] of directory.entries()) {
        if (cancelRequested) throw new Error("用户已取消扫描");
        const path = joinPath(prefix, name);
        if (handle.kind === "directory") {
          inventory.folders[kind].add(path);
          await scan(handle, kind, path);
        } else if ((kind === "JSON" && /\.json$/i.test(path)) || (kind === "Markdown" && /\.md$/i.test(path))) {
          inventory.files[kind].add(path);
          scannedFiles++;
          onProgress({ scannedFiles, kind, path });
          try {
            const observed = await readObservedFileIdentity(handle, kind, path);
            if (observed) observedFiles.push(observed);
            else {
              unreadableFiles.push(`${kind}/${path}: 缺少 conversation_id`);
              unreadableEntries.push({ kind, path: joinPath(kind, path), reason: "缺少 conversation_id" });
            }
          } catch (error) {
            unreadableFiles.push(`${kind}/${path}: ${error.message}`);
            unreadableEntries.push({ kind, path: joinPath(kind, path), reason: error.message || String(error) });
          }
        }
        if (cancelRequested) throw new Error("用户已取消扫描");
      }
    };
    for (const kind of ["JSON", "Markdown"]) {
      try {
        const directory = await getDirectory(root, kind, false);
        rootsPresent[kind] = true;
        await scan(directory, kind);
      } catch (error) {
        if (error?.name !== "NotFoundError") throw error;
      }
    }
    const audit = buildFolderAudit({
      folders: {
        JSON: [...inventory.folders.JSON],
        Markdown: [...inventory.folders.Markdown],
      },
      files: {
        JSON: [...inventory.files.JSON],
        Markdown: [...inventory.files.Markdown],
      },
    }, classificationRules);
    const index = await loadIndex(root);
    const stateLayer = await ensureConversationState(root, index, observedFiles);
    const hasStateBaseline = Object.keys(stateLayer.state.conversations || {}).length > 0;
    const scanTrusted = (rootsPresent.JSON && rootsPresent.Markdown) || (!hasStateBaseline && observedFiles.length === 0);
    const stateChangeResult = detectConversationChanges(stateLayer.state, observedFiles, {
      unreadableFiles: unreadableEntries,
      scanTrusted,
    });
    audit.indexPathDrifts = [];
    audit.observedFiles = observedFiles;
    audit.unreadableFiles = unreadableFiles;
    audit.unreadableEntries = unreadableEntries;
    audit.rootsPresent = rootsPresent;
    audit.scanTrusted = scanTrusted;
    audit.conversationState = stateLayer.state;
    audit.stateBaselineCreated = stateLayer.created;
    audit.stateChangeResult = stateChangeResult;
    audit.conversationChanges = stateChangeResult.changes;
    const folderState = await loadFolderState(root);
    const folderChangeResult = detectFolderChanges(folderState, audit, classificationRules);
    audit.folderState = folderState;
    audit.folderChangeResult = folderChangeResult;
    audit.folderChanges = folderChangeResult.changes;
    const autoHandledIds = new Set(stateChangeResult.changes
      .filter((item) => ["move", "delete"].includes(item.type))
      .map((item) => item.conversation_id));
    const detectedIssues = buildConversationIssues(index, observedFiles, classificationRules, classificationOverrides)
      .filter((issue) => !autoHandledIds.has(issue.conversation_id));
    audit.missingFileIssues = detectedIssues.filter(isMissingOnlyIssue);
    audit.conversationIssues = detectedIssues.filter((issue) => !isMissingOnlyIssue(issue));
    const folderIsIgnored = (folder) => ignoredFolders.some((ignored) => folder === ignored || folder.startsWith(`${ignored}/`));
    // “忽略”既可以表示不再提示登记，也可以暂存一个空目录决定。
    // 暂存的决定从当前待处理队列移走，但保留在 audit 里供“之前忽略的项目”展示和恢复。
    audit.ignoredFolderDecisions = (audit.folderChanges || [])
      .filter((item) => item.type === "decide-empty-folder" && folderIsIgnored(item.folder));
    audit.folderChanges = (audit.folderChanges || [])
      .filter((item) => !(item.type === "decide-empty-folder" && folderIsIgnored(item.folder)));
    if (audit.folderChangeResult) audit.folderChangeResult = { ...audit.folderChangeResult, changes: audit.folderChanges };
    audit.onlyJsonFolders = audit.onlyJsonFolders.filter((folder) => folder !== SYSTEM_INBOX_FOLDER && !folderIsIgnored(folder));
    audit.onlyMarkdownFolders = audit.onlyMarkdownFolders.filter((folder) => folder !== SYSTEM_INBOX_FOLDER && !folderIsIgnored(folder));
    // 新建/手动移动到一个尚未登记规则的目录后，这条建议应一直保留，
    // 直到用户明确“登记”或“忽略”。不能因为索引已经跟着移动就把建议吃掉。
    // 但如果这个目录当前正处于“空目录只剩一边”的选择状态，就不要在下面重复显示一遍登记建议。
    const pendingEmptyFolderPaths = new Set((audit.folderChanges || [])
      .filter((item) => item.type === "decide-empty-folder")
      .map((item) => item.folder));
    audit.unregisteredFolders = audit.unregisteredFolders
      .filter((item) => !folderIsIgnored(item.path) && !pendingEmptyFolderPaths.has(item.path));
    if (index?.conversations) {
      audit.indexPathDrifts = audit.conversationIssues
        .filter((issue) => issue.types.includes("index-drift"))
        .map((issue) => ({
          conversation_id: issue.conversation_id, title: issue.title,
          expected_json: issue.indexed_json, actual_json: issue.json_paths[0] || null,
          expected_markdown: issue.indexed_markdown, actual_markdown: issue.markdown_paths[0] || null,
        }));
    }
    const unresolvedFileIssue = audit.conversationIssues.some((issue) => issue.types.some((type) => [
      "missing-json", "missing-markdown", "duplicate-json", "duplicate-markdown", "split-folders", "index-drift", "wrong-target",
    ].includes(type)));
    audit.hasDrift = Boolean(
      audit.indexPathDrifts.length || unresolvedFileIssue || audit.missingFileIssues.length || audit.unreadableFiles.length
      || stateChangeResult.changes.some((item) => ["conflict", "uncertain"].includes(item.type))
      || (audit.folderChanges || []).some((item) => item.type === "decide-empty-folder")
    );
    return audit;
  }

  function folderAuditLines(audit) {
    const lines = [];
    if (audit.unregisteredFolders.length) lines.push(`可选分类目录：${audit.unregisteredFolders.map((item) => item.path).join("、")}`);
    if (audit.folderChanges?.some((item) => item.type === "decide-empty-folder")) lines.push(`有 ${audit.folderChanges.filter((item) => item.type === "decide-empty-folder").length} 个空目录需要你选择：删除剩下的一边，或把缺的一边补回来。`);
    if (audit.missingRuleTargets.length) lines.push(`规则目标目录待自动补齐：${audit.missingRuleTargets.join("、")}`);
    if (audit.missingFileIssues?.length) lines.push(`本地文件缺失待确认：${audit.missingFileIssues.length} 个对话`);
    if (audit.pathMismatches.length) lines.push(`JSON 与 Markdown 位于不同分类目录：${audit.pathMismatches.length} 对`);
    if (audit.indexPathDrifts?.length) lines.push(`发现文件管理器手动移动、但索引尚未同步：${audit.indexPathDrifts.length} 个对话`);
    if (audit.conversationIssues?.length) lines.push(`需要整理的对话：${audit.conversationIssues.length} 个`);
    if (audit.unreadableFiles?.length) lines.push(`无法识别或读取的文件：${audit.unreadableFiles.length} 个`);
    if (audit.stateChangeResult?.trusted === false) lines.push(`本地变化判断暂停：${audit.stateChangeResult.reason}`);
    if (audit.conversationChanges?.length) {
      const counts = audit.conversationChanges.reduce((acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + 1;
        return acc;
      }, {});
      lines.push(`本地对话变化：移动 ${counts.move || 0}｜删除 ${counts.delete || 0}｜冲突 ${counts.conflict || 0}｜无法判断 ${counts.uncertain || 0}｜补齐 ${counts.repair || 0}`);
    }
    return lines;
  }

  const ISSUE_LABELS = {
    "missing-json": "缺少 JSON",
    "missing-markdown": "缺少 Markdown",
    "duplicate-json": "多个 JSON 副本",
    "duplicate-markdown": "多个 Markdown 副本",
    "split-folders": "双格式分居",
    "index-drift": "索引位置不一致",
    "unclassified": "未归类",
    "wrong-target": "不在规则目标目录",
  };

  function isMissingOnlyIssue(issue) {
    const types = new Set(issue?.types || []);
    return types.size > 0 && [...types].every((type) => ["missing-json", "missing-markdown"].includes(type));
  }

  function missingIssueText(issue) {
    const missingJson = issue?.types?.includes("missing-json");
    const missingMarkdown = issue?.types?.includes("missing-markdown");
    if (missingJson && missingMarkdown) return "JSON 和 Markdown 都已经找不到。若这是你之前手动删除的，直接确认即可；插件会清理索引并记录删除状态。";
    if (missingJson) return "JSON 已经找不到，但 Markdown 还在。若你本来就是要删除这个对话，可以删除整个对话；否则先不要操作。";
    if (missingMarkdown) return "Markdown 已经找不到，但 JSON 还在。若你本来就是要删除这个对话，可以删除整个对话；否则先不要操作。";
    return "本地文件状态需要确认。";
  }

  function renderConversationIssues(audit = ui?._folderAudit) {
    if (!ui?.organizer || !ui?.issueList || !ui?.issueTargetRule) return;
    const issues = (audit?.conversationIssues || []).filter((issue) => !isMissingOnlyIssue(issue));
    ui.organizer.hidden = !issues.length;
    ui.issueTargetRule.innerHTML = '<option value="">选择目标分类</option>'
      + classificationRules.filter((rule) => !rule.format_pending).map((rule) =>
        `<option value="${escapeHtml(rule.rule_id)}">${escapeHtml(rule.field)} · ${escapeHtml(ruleTargetFolder(rule))}</option>`).join("");
    ui.issueList.innerHTML = issues.map((issue) => {
      const types = issue.types.map((type) => ISSUE_LABELS[type] || type).join("、");
      const paths = [...issue.json_paths, ...issue.markdown_paths].join("\n") || "未找到实际文件";
      return `<label class="issue-row">
        <input type="checkbox" data-role="issue-select" value="${escapeHtml(issue.conversation_id)}" />
        <span><strong>${escapeHtml(issue.title)}</strong><small>${escapeHtml(types)}</small><small>${escapeHtml(paths)}</small></span>
      </label>`;
    }).join("");
    ui.issuePreview.hidden = true;
    ui.issuePreview.textContent = "";
  }

  function selectedConversationIssueIds() {
    return [...(ui?.issueList?.querySelectorAll('[data-role="issue-select"]:checked') || [])]
      .map((input) => input.value);
  }

  function selectConversationIssuesForFolder(folderPath) {
    const issueIds = new Set((ui?._folderAudit?.conversationIssues || [])
      .filter((issue) => [...issue.json_paths, ...issue.markdown_paths]
        .some((path) => path.split("/").slice(1, -1).join("/") === folderPath))
      .map((issue) => issue.conversation_id));
    for (const input of ui.issueList.querySelectorAll('[data-role="issue-select"]')) input.checked = issueIds.has(input.value);
    if (issueIds.size) setManageScene("organizer", 1);
    setStatus(issueIds.size ? `已选中 ${issueIds.size} 个对话，请选择最终分类。` : "这个文件夹中没有需要按 conversation_id 整理的对话。", issueIds.size ? "normal" : "warning");
  }

  function buildSelectedMigrationPreview() {
    const ids = selectedConversationIssueIds();
    const rule = classificationRules.find((item) => item.rule_id === ui.issueTargetRule.value);
    if (!ids.length) throw new Error("请先选择至少一个对话");
    if (!rule) throw new Error("请选择目标分类");
    const issueMap = new Map((ui._folderAudit?.conversationIssues || []).map((issue) => [issue.conversation_id, issue]));
    const lines = ids.map((id) => {
      const issue = issueMap.get(id);
      const classification = classificationFromRule(rule, issue?.title, "user-selection");
      const desired = archivePaths(issue?.title, id, classification);
      return `${issue?.title || id}\n  JSON -> ${desired.json}\n  Markdown -> ${desired.markdown}`;
    });
    const text = `将 ${ids.length} 个对话归入 ${ruleTargetFolder(rule)}\n\n${lines.slice(0, 30).join("\n\n")}${lines.length > 30 ? `\n\n另有 ${lines.length - 30} 个对话` : ""}`;
    ui.issuePreview.hidden = false;
    ui.issuePreview.textContent = text;
    return { ids, rule, text };
  }

  function stateChangeDetailText(item) {
    const label = item.kind === "json" ? "JSON" : "Markdown";
    if (item.type === "none") return `${label}：未变化`;
    if (item.type === "delete") return `${label}：${item.from || "（无）"} -> [删除]`;
    if (item.type === "move") return `${label}：${item.from || "（无）"} -> ${item.to || "（无）"}`;
    if (item.type === "add") return `${label}：[无基线] -> ${item.to || "（无）"}`;
    if (item.type === "ambiguous") return `${label}：发现多个副本 ${item.candidates.join(" | ")}`;
    if (item.type === "uncertain") return `${label}：无法确认（${item.reason || "状态不明确"}）`;
    return `${label}：${item.type}`;
  }

  function renderConversationStateChanges(audit = ui?._folderAudit) {
    if (!ui?.stateChanges || !ui?.stateChangesList) return;
    const result = audit?.stateChangeResult || { trusted: true, changes: [] };
    const changes = result.changes || [];
    const missingIssues = audit?.missingFileIssues || [];
    const folderDecisions = (audit?.folderChanges || []).filter((item) => item.type === "decide-empty-folder");
    if (!result.trusted) {
      ui.stateChanges.hidden = false;
      if (ui.stateChangesProgress) ui.stateChangesProgress.textContent = "需要重新检查";
      ui.stateChanges.dataset.kind = "warning";
      ui.stateChangesList.innerHTML = `<div class="focus-item conflict"><div><strong>本次扫描不完整</strong><span>为了避免误删，插件没有自动判断本地变化。</span></div><button data-action="folder-scan">重新检查</button></div>`;
      return;
    }

    const rows = [];
    for (const change of changes) {
      const css = ["conflict", "uncertain"].includes(change.type) ? " conflict" : "";
      let detail = "";
      let button = "";
      if (change.type === "delete") {
        const deletedSide = (change.representations || []).filter((item) => item.type === "delete").map((item) => item.kind === "json" ? "JSON" : "Markdown").join("、");
        detail = `${deletedSide || "本地文件"} 已删除。确认后会把剩余文件移入“已删除”，并记住这次删除。`;
        button = `<button class="btn-primary" data-action="state-apply" data-conversation-id="${escapeHtml(change.conversation_id)}">确认删除</button>`;
      } else if (change.type === "move") {
        detail = `这个对话被移动到了：${change.target_folder ? escapeHtml(change.target_folder) : "根目录"}。另一种格式还没跟过去。`;
        button = `<button class="btn-primary" data-action="state-apply" data-conversation-id="${escapeHtml(change.conversation_id)}">把另一份也移过去</button>`;
      } else if (change.type === "conflict") {
        detail = "JSON 和 Markdown 被改到了不同位置，需要你决定最终放在哪里。";
        button = `<button class="btn-primary" data-action="manage-organizer">选择最终位置</button>`;
      } else if (change.type === "uncertain") {
        detail = "发现重复文件或无法确认的位置，插件先停在这里，不自动改文件。";
        button = `<button data-action="manage-organizer">查看需要整理的对话</button>`;
      } else {
        detail = "发现需要补齐的本地状态。";
        button = `<button data-action="folder-scan">重新检查</button>`;
      }
      rows.push(`<div class="focus-item${css}"><div><strong>${escapeHtml(change.title || change.conversation_id)}</strong><span>${detail}</span></div>${button}</div>`);
    }

    for (const issue of missingIssues) {
      const bothMissing = issue.types.includes("missing-json") && issue.types.includes("missing-markdown");
      rows.push(`<div class="focus-item conflict">
        <div><strong>${escapeHtml(issue.title || issue.conversation_id)}</strong><span>${escapeHtml(missingIssueText(issue))}</span></div>
        <button class="btn-primary" data-action="issue-delete" data-conversation-id="${escapeHtml(issue.conversation_id)}">${bothMissing ? "确认已删除" : "删除整个对话"}</button>
      </div>`);
    }

    for (const change of folderDecisions) {
      const where = change.present_in || "这一边";
      const missing = change.missing_in || "另一边";
      const detail = change.previously_paired
        ? `你删掉了 ${missing} 里的这个空目录，${where} 里还留着一个。`
        : `这个空目录现在只在 ${where} 里。`;
      rows.push(`<div class="focus-item">
        <div><strong>${escapeHtml(change.folder)}</strong><span>${escapeHtml(detail)}</span></div>
        <div class="focus-actions">
          <button data-action="folder-empty-delete" data-folder-path="${escapeHtml(change.folder)}">删除这个空文件夹</button>
          <button class="btn-primary" data-action="folder-empty-mirror" data-folder-path="${escapeHtml(change.folder)}">补上另一边</button>
          <button class="btn-quiet span-all" data-action="folder-empty-ignore" data-folder-path="${escapeHtml(change.folder)}">先忽略</button>
        </div>
      </div>`);
    }

    ui.stateChanges.hidden = !rows.length;
    ui.stateChanges.dataset.kind = rows.some((row) => row.includes("conflict")) ? "warning" : "normal";
    ui.stateChangesList.innerHTML = rows[0] || "";
    if (ui.stateChangesProgress) ui.stateChangesProgress.textContent = rows.length > 1 ? `1 / ${rows.length}` : rows.length ? "当前这一件" : "";
  }

  function renderFolderDiscoveries(audit = ui?._folderAudit) {
    renderConversationStateChanges(audit);
    if (audit?.folders) populateRuleFolderChoices([...(audit.folders.JSON || []), ...(audit.folders.Markdown || [])]);
    renderIgnoredItems();
    if (!ui?.folderDiscovery || !ui?.folderDiscoveryList) return;
    const unregistered = audit?.unregisteredFolders || [];
    ui.folderDiscovery.hidden = !unregistered.length;
    ui.folderDiscovery.dataset.kind = "normal";
    if (!unregistered.length) {
      ui.folderDiscoveryList.innerHTML = "";
      if (ui.folderDiscoveryProgress) ui.folderDiscoveryProgress.textContent = "";
      renderConversationIssues(audit);
      updateManageHomeSummary(audit);
      return;
    }
    const item = unregistered[0];
    const location = item.present_in.length === 2 ? "JSON、Markdown 两边都有" : `目前只在 ${item.present_in.join("、")} 里`;
    const hasContent = (item.present_in || []).some((kind) => folderTreeHasContent(audit, kind, item.path));
    const canOfferDelete = item.present_in.length === 1 || !hasContent;
    const deleteButton = canOfferDelete ? `<button data-action="folder-delete-empty" data-folder-path="${escapeHtml(item.path)}">删除空目录</button>` : "";
    ui.folderDiscoveryList.innerHTML = `<div class="focus-item">
      <div><strong>${escapeHtml(item.path)}</strong><span>${escapeHtml(location)}。如果以后想让这类对话自动进这里，就登记；不想管就忽略。</span></div>
      <div class="focus-actions">
        <button class="btn-primary" data-action="folder-register" data-folder-path="${escapeHtml(item.path)}">登记</button>
        <button data-action="folder-ignore" data-folder-path="${escapeHtml(item.path)}">忽略</button>
        ${deleteButton}
      </div>
    </div>`;
    if (ui.folderDiscoveryProgress) ui.folderDiscoveryProgress.textContent = unregistered.length > 1 ? `1 / ${unregistered.length}` : "当前这一件";
    renderConversationIssues(audit);
    updateManageHomeSummary(audit);
  }

  function currentPathForRepresentation(change, kind) {
    const item = (change?.representations || []).find((candidate) => candidate.kind === kind);
    if (!item) return "";
    if (["none", "move", "add"].includes(item.type)) return normalizeStatePath(item.to || item.from || "");
    return "";
  }

  function deletedDestination(path, kind) {
    const normalized = normalizeStatePath(path);
    const prefix = kind === "json" ? "JSON/" : "Markdown/";
    const relative = normalized.toLowerCase().startsWith(prefix.toLowerCase()) ? normalized.slice(prefix.length) : normalized;
    return joinPath(SYSTEM_DELETED_FOLDER, kind === "json" ? "JSON" : "Markdown", relative);
  }

  async function moveTextSafely(root, source, destination, conversationId, kind) {
    if (!source || source === destination) return destination;
    const io = directoryIo(root);
    await assertRelocationTargetSafe(io, destination, conversationId, kind === "json" ? "JSON" : "Markdown");
    const text = await readText(root, source);
    if (text === null) return "";
    await writeText(root, destination, text);
    await removeFile(root, source);
    try { await removeEmptyAncestorDirectories(root, source); } catch { /* best effort */ }
    return destination;
  }

  async function applyDetectedDelete(root, change) {
    const id = String(change.conversation_id || "");
    const index = (await loadIndex(root)) || emptyIndex();
    const state = await loadConversationState(root);
    const deleted = await loadDeletedConversations(root);
    const jsonSource = currentPathForRepresentation(change, "json");
    const markdownSource = currentPathForRepresentation(change, "markdown");
    let deletedJson = "";
    let deletedMarkdown = "";
    if (jsonSource) deletedJson = await moveTextSafely(root, jsonSource, deletedDestination(jsonSource, "json"), id, "json");
    if (markdownSource) deletedMarkdown = await moveTextSafely(root, markdownSource, deletedDestination(markdownSource, "markdown"), id, "markdown");
    const previous = state.conversations[id] || stateEntryFromIndexEntry(index.conversations[id] || {});
    state.conversations[id] = normalizeStateEntry({
      ...previous, title: change.title || previous.title, state: "deleted",
      last_known: { json_path: deletedJson || "", markdown_path: deletedMarkdown || "" },
      baseline_at: new Date().toISOString(),
    });
    deleted.deleted[id] = { title: change.title || previous.title || "未命名对话", deleted_at: new Date().toISOString(), source: "local-manager" };
    delete index.conversations[id];
    if (classificationOverrides[id]) {
      delete classificationOverrides[id];
      await writeSharedClassificationRules(root);
    }
    await persistIndexes(root, index);
    await persistConversationState(root, state);
    await persistDeletedConversations(root, deleted);
    try {
      const archives = await readIndexedArchives(root, index);
      if (!archives.issues.length) await writeJson(root, "timeline.json", timelineFromArchives(archives.archives));
    } catch { /* keep old timeline on non-critical failure */ }
    return { conversation_id: id, type: "delete" };
  }

  async function confirmMissingIssueDeleted(conversationId) {
    const issue = (ui?._folderAudit?.missingFileIssues || []).find((item) => item.conversation_id === conversationId);
    if (!issue) throw new Error("这条文件缺失记录已经不存在，请重新检查");
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    const makeRepresentation = (kind, actualPaths, indexedPath) => {
      const actual = actualPaths?.[0] || "";
      return actual
        ? { kind, type: "none", from: actual, to: actual, candidates: [actual] }
        : { kind, type: "delete", from: indexedPath || "", to: "", candidates: [] };
    };
    const change = {
      conversation_id: issue.conversation_id,
      title: issue.title,
      type: "delete",
      representations: [
        makeRepresentation("json", issue.json_paths, issue.indexed_json),
        makeRepresentation("markdown", issue.markdown_paths, issue.indexed_markdown),
      ],
    };
    setStatus(`正在确认删除：${issue.title}`, "normal", true);
    await applyDetectedDelete(directory.handle, change);
    const audit = await auditExportFolders(directory.handle);
    ui._folderAudit = audit;
    renderFolderDiscoveries(audit);
    setStatus(`已确认删除：${issue.title}\n已记住这次删除；以后导出不会把它自动加回来。`, "ok");
  }

  async function applyDetectedMove(root, change) {
    const id = String(change.conversation_id || "");
    const target = normalizeStatePath(change.target || "");
    if (!target) throw new Error("无法确定移动目标");
    const targetFolder = String(change.target_folder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const index = (await loadIndex(root)) || emptyIndex();
    const jsonSource = currentPathForRepresentation(change, "json");
    if (!jsonSource) throw new Error("移动需要可读取的 JSON 档案；当前 JSON 不存在或状态不明确");
    const archive = await readJson(root, jsonSource);
    if (String(archive?.conversation_id || "") !== id) throw new Error("当前 JSON conversation_id 与待移动对话不一致");
    const jsonDestination = `JSON/${target}.json`;
    const markdownDestination = `Markdown/${target}.md`;
    const folderParts = targetFolder.split("/").filter(Boolean);
    archive.classification = {
      kind: "本地目录", name: folderParts.at(-1) || targetFolder || "根目录", folder: targetFolder,
      root_folder: folderParts[0] || "", child_folders: folderParts.slice(1), conversation_name: archive.title || change.title || "未命名对话",
      file_title: archive.title || change.title || "未命名对话", prefix: "", field: "", rule_id: null,
      matched_alias: false, source: "manual-folder-direct",
    };
    archive.json_path = jsonDestination;
    archive.markdown_path = markdownDestination;
    const io = directoryIo(root);
    await assertRelocationTargetSafe(io, jsonDestination, id, "JSON");
    await assertRelocationTargetSafe(io, markdownDestination, id, "Markdown");
    await writeJson(root, jsonDestination, archive);
    await writeText(root, markdownDestination, buildMarkdown(archive));
    for (const kind of ["json", "markdown"]) {
      const source = currentPathForRepresentation(change, kind);
      const destination = kind === "json" ? jsonDestination : markdownDestination;
      if (source && source !== destination) {
        try {
          await removeFile(root, source);
          // 这里故意只移动文件，不顺手删除原文件夹。
          // 用户在资源管理器里“把最后一个文件移走”并不等于“删除这个文件夹”；
          // 保留两边的空目录，后续如果用户真的删除其中一边，再由目录状态逻辑同步删除另一边。
        } catch (error) {
          if (error?.name !== "NotFoundError") throw error;
        }
      }
    }
    index.conversations[id] = indexEntryFromArchive(archive, { json: jsonDestination, markdown: markdownDestination });
    classificationOverrides[id] = { rule_id: null, folder: targetFolder, source: "manual-folder-direct", updated_at: new Date().toISOString() };
    await writeSharedClassificationRules(root);
    await persistIndexes(root, index);
    const state = await loadConversationState(root);
    state.conversations[id] = stateEntryFromIndexEntry(index.conversations[id], new Date().toISOString());
    await persistConversationState(root, state);
    return { conversation_id: id, type: "move", json_path: jsonDestination, markdown_path: markdownDestination };
  }

  async function applyDetectedConversationChange(conversationId) {
    const change = (ui?._folderAudit?.conversationChanges || []).find((item) => item.conversation_id === conversationId);
    if (!change) throw new Error("这条本地变化已经不存在，请重新扫描");
    if (!["move", "delete"].includes(change.type)) throw new Error("这条变化需要人工判断，不能自动应用");
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    setStatus(change.type === "delete" ? `正在处理删除：${change.title}` : `正在处理移动：${change.title}`, "normal", true);
    if (change.type === "delete") await applyDetectedDelete(directory.handle, change);
    else await applyDetectedMove(directory.handle, change);
    const remaining = (ui._folderAudit.conversationChanges || []).filter((item) => item.conversation_id !== conversationId);
    ui._folderAudit.conversationChanges = remaining;
    if (ui._folderAudit.stateChangeResult) ui._folderAudit.stateChangeResult.changes = remaining;
    renderConversationStateChanges(ui._folderAudit);
    setStatus(`${change.type === "delete" ? "已删除" : "已处理移动"}：${change.title}\n只处理了这一个对话，没有重新下载其他网页对话。`, "ok");
  }

  async function applyAllDetectedConversationChanges() {
    const changes = (ui?._folderAudit?.conversationChanges || []).filter((item) => ["move", "delete"].includes(item.type));
    if (!changes.length) throw new Error("没有可以自动处理的本地变化");
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    let done = 0;
    const failures = [];
    for (const change of changes) {
      try {
        setStatus(`正在应用本地变化 ${done + 1}/${changes.length}\n${change.title}`, "normal", true);
        if (change.type === "delete") await applyDetectedDelete(directory.handle, change);
        else await applyDetectedMove(directory.handle, change);
        done++;
      } catch (error) {
        failures.push(`${change.title}：${error.message || error}`);
      }
    }
    const audit = await auditExportFolders(directory.handle);
    ui._folderAudit = audit;
    populateRuleFolderChoices([...(audit.folders?.JSON || []), ...(audit.folders?.Markdown || [])]);
    renderFolderDiscoveries(audit);
    setStatus(`本地管理完成\n已处理 ${done} 个｜失败 ${failures.length} 个\n这里只处理本地变化，没有下载网页端对话正文。${failures.length ? `\n${failures.slice(0, 8).join("\n")}` : ""}`, failures.length ? "warning" : "ok");
  }

  function inferRemoteTitleCandidate(title) {
    const text = String(title || "").trim();
    let match = text.match(/^([A-Z][A-Z0-9]{0,15})(\s+|[-/_：:])(.+)$/);
    if (!match) match = text.match(/^([\u3400-\u9fff]{1,8})([-/_：:])(.+)$/);
    if (!match) return null;
    const connector = /^\s+$/.test(match[2]) ? " " : match[2] === ":" ? "：" : match[2];
    return { field: match[1].toUpperCase(), connector, example: text };
  }

  async function scanRemoteTitleRules() {
    setStatus("正在读取 ChatGPT 对话标题；只读取目录标题，不下载对话正文……", "normal", true);
    const adapter = resolvePlatformAdapter();
    const session = await adapter.getSession();
    if (!session.ok) throw new Error("当前 ChatGPT 登录状态不可用");
    const inventory = await adapter.fetchInventory(session.token);
    const groups = new Map();
    for (const item of inventory.items || []) {
      if (classifyTitle(item.title || "", classificationRules)) continue;
      const candidate = inferRemoteTitleCandidate(item.title);
      if (!candidate) continue;
      const key = ignoredTitleFormatKey(candidate.field, candidate.connector);
      if (ignoredRemoteTitleFormats.some((ignored) => ignoredTitleFormatKey(ignored.field, ignored.connector) === key)) continue;
      if (!groups.has(key)) groups.set(key, { ...candidate, count: 0, examples: [] });
      const group = groups.get(key);
      group.count++;
      if (group.examples.length < 3) group.examples.push(item.title);
    }
    const candidates = [...groups.values()].sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
    ui._remoteRuleCandidates = candidates;
    renderRemoteRuleCandidates(candidates);
    setStatus(candidates.length ? `网页标题扫描完成\n发现 ${candidates.length} 组可选命名建议；可以登记，也可以忽略。` : "网页标题扫描完成：没有新的命名建议。", candidates.length ? "normal" : "ok");
  }

  function renderRemoteRuleCandidates(candidates = ui?._remoteRuleCandidates || []) {
    if (!ui?.remoteRuleCandidates) return;
    ui.remoteRuleCandidates.hidden = !candidates.length;
    ui.remoteRuleCandidates.innerHTML = candidates.map((item, index) => `<div class="candidate-row">
      <div><strong>${escapeHtml(item.field)} ${escapeHtml(delimiterLabel(item.connector))}</strong><span>${item.count} 个网页对话 · ${escapeHtml(item.examples[0] || "")}</span></div>
      <div class="discovery-actions"><button data-action="remote-rule-prefill" data-candidate-index="${index}">登记</button><button data-action="remote-rule-ignore" data-candidate-index="${index}">忽略</button></div>
    </div>`).join("");
  }

  function prefillRemoteRuleCandidate(index) {
    const candidate = (ui?._remoteRuleCandidates || [])[Number(index)];
    if (!candidate) throw new Error("网页命名候选已失效，请重新扫描");
    ui.ruleField.value = candidate.field;
    const connectorMap = { "": "__none__", " ": "__space__", "-": "-", "/": "/", "_": "_", "：": "：" };
    ui.ruleConnector.value = connectorMap[candidate.connector] || "__custom__";
    ui.ruleConnectorCustom.hidden = ui.ruleConnector.value !== "__custom__";
    if (!ui.ruleConnectorCustom.hidden) ui.ruleConnectorCustom.value = candidate.connector;
    ui.ruleRootFolder.value = "";
    if (ui.ruleRootFolderChoice) ui.ruleRootFolderChoice.value = "";
    ui.ruleFolderSeparator.value = "__none__";
    ui.ruleSubfolderField.hidden = true;
    updateRulePreview();
    openRuleEditorAndJump();
    setTimeout(() => ui?.ruleRootFolder?.focus(), 220);
    setStatus(`网页命名已经填进分类设置：${candidate.field}${delimiterLabel(candidate.connector)}。再选它要进入的文件夹即可。`, "normal");
  }

  async function ignoreRemoteRuleCandidate(index) {
    const candidate = (ui?._remoteRuleCandidates || [])[Number(index)];
    if (!candidate) throw new Error("这个网页命名建议已经不存在");
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    const key = ignoredTitleFormatKey(candidate.field, candidate.connector);
    ignoredRemoteTitleFormats = normalizeIgnoredTitleFormats([
      ...ignoredRemoteTitleFormats,
      { field: candidate.field, connector: candidate.connector },
    ]);
    await writeSharedClassificationRules(directory.handle);
    ui._remoteRuleCandidates = (ui._remoteRuleCandidates || []).filter((item) => ignoredTitleFormatKey(item.field, item.connector) !== key);
    renderRemoteRuleCandidates(ui._remoteRuleCandidates);
    renderIgnoredItems();
    setStatus(`已忽略网页命名建议：${candidate.field}${delimiterLabel(candidate.connector)}\n它以后不会再作为待登记项目提醒你。`, "ok");
  }

  async function listLogicalFolderPaths(root) {
    const folders = new Set();
    const walk = async (directory, prefix = "") => {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== "directory") continue;
        const path = joinPath(prefix, name);
        folders.add(path);
        await walk(handle, path);
      }
    };
    for (const kind of ["JSON", "Markdown"]) {
      try { await walk(await getDirectory(root, kind, false)); }
      catch (error) { if (error?.name !== "NotFoundError") throw error; }
    }
    return [...folders].filter((path) => path && path !== SYSTEM_INBOX_FOLDER && !path.startsWith(`${SYSTEM_INBOX_FOLDER}/`)).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  function populateRuleSubfolderChoices() {
    if (!ui?.ruleSubfolderChoice) return;
    const root = String(ui.ruleRootFolder?.value || "").trim().replace(/^\/+|\/+$/g, "");
    const prefix = root ? `${root}/` : "";
    const options = (ui._ruleFolderPaths || [])
      .filter((path) => prefix && path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .filter(Boolean);
    ui.ruleSubfolderChoice.innerHTML = '<option value="">选择已有子文件夹</option>'
      + [...new Set(options)].map((path) => `<option value="${escapeHtml(path)}">${escapeHtml(path)}</option>`).join("");
  }

  function populateRuleFolderChoices(paths = ui?._ruleFolderPaths || []) {
    if (!ui?.ruleRootFolderChoice) return;
    ui._ruleFolderPaths = [...new Set(paths || [])].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const roots = [...new Set(ui._ruleFolderPaths.map((path) => path.split("/")[0]).filter((root) => root && root !== SYSTEM_INBOX_FOLDER))];
    ui.ruleRootFolderChoice.innerHTML = '<option value="">选择已有一级文件夹</option>'
      + roots.map((root) => `<option value="${escapeHtml(root)}">${escapeHtml(root)}</option>`).join("");
    populateRuleSubfolderChoices();
  }

  async function refreshRuleFolderChoices({ interactive = false } = {}) {
    const directory = await getAuthorizedDirectory(interactive);
    if (!directory.handle) return [];
    const paths = await listLogicalFolderPaths(directory.handle);
    populateRuleFolderChoices(paths);
    return paths;
  }

  async function restoreIgnoredFolder(folderPath) {
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    const previous = [...ignoredFolders];
    ignoredFolders = ignoredFolders.filter((item) => item !== folderPath);
    try { await writeSharedClassificationRules(directory.handle); }
    catch (error) { ignoredFolders = previous; throw error; }
    const audit = await refreshFolderDiscoveries({ interactive: false, announce: false });
    renderIgnoredItems();
    if (audit) routeManageAfterAudit(audit);
    setStatus(`已重新拿出来处理：${folderPath}`, "normal");
  }

  async function registerIgnoredFolder(folderPath) {
    // 不在“点登记”这一刻移出忽略；只有真正保存规则后才移出。
    // 这样用户进入编辑器后取消，不会丢掉原来的忽略状态。
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    prefillRuleFromFolder(folderPath, { returnScene: "ignored" });
  }

  async function restoreIgnoredRemoteTitle(index) {
    const item = ignoredRemoteTitleFormats[Number(index)];
    if (!item) throw new Error("这个已忽略命名不存在");
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    const key = ignoredTitleFormatKey(item.field, item.connector);
    ignoredRemoteTitleFormats = ignoredRemoteTitleFormats.filter((candidate) => ignoredTitleFormatKey(candidate.field, candidate.connector) !== key);
    await writeSharedClassificationRules(directory.handle);
    renderIgnoredItems();
    setStatus(`已恢复网页命名建议：${item.field}${delimiterLabel(item.connector)}`, "ok");
  }

  async function registerIgnoredRemoteTitle(index) {
    const item = ignoredRemoteTitleFormats[Number(index)];
    if (!item) throw new Error("这个已忽略命名不存在");
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    const key = ignoredTitleFormatKey(item.field, item.connector);
    ignoredRemoteTitleFormats = ignoredRemoteTitleFormats.filter((candidate) => ignoredTitleFormatKey(candidate.field, candidate.connector) !== key);
    await writeSharedClassificationRules(directory.handle);
    renderIgnoredItems();
    const candidate = { field: item.field, connector: item.connector, count: 0, examples: [] };
    ui._remoteRuleCandidates = [candidate, ...(ui._remoteRuleCandidates || []).filter((entry) => ignoredTitleFormatKey(entry.field, entry.connector) !== key)];
    prefillRemoteRuleCandidate(0);
  }

  function renderIgnoredItems() {
    if (!ui?.ignoredDetails || !ui?.ignoredList) return;
    const audit = ui?._folderAudit;
    const decisionMap = new Map((audit?.ignoredFolderDecisions || []).map((item) => [item.folder, item]));
    const folderPresence = (folder) => ["JSON", "Markdown"].filter((kind) => (audit?.folders?.[kind] || []).includes(folder));
    const folderRows = ignoredFolders.map((folder) => {
      const decision = decisionMap.get(folder);
      const presentIn = decision ? [decision.present_in] : folderPresence(folder);
      const existenceKnown = Boolean(audit?.folders);
      const exists = !existenceKnown || presentIn.length > 0;
      if (!exists) return "";
      const hasContent = Boolean(audit) && presentIn.some((kind) => folderTreeHasContent(audit, kind, folder));
      const canDelete = Boolean(audit) && presentIn.length > 0 && !hasContent;
      const deleteButton = canDelete
        ? `<button data-action="ignore-delete-empty-folder" data-folder-path="${escapeHtml(folder)}">删除空目录</button>`
        : "";
      if (decision) {
        return `<div class="candidate-row"><div><strong>${escapeHtml(folder)}</strong><span>这个空目录先放在这里；目前只剩 ${escapeHtml(decision.present_in || "一边")}。</span></div><div class="row-actions"><button class="btn-primary" data-action="ignore-restore-folder" data-folder-path="${escapeHtml(folder)}">处理</button>${deleteButton}</div></div>`;
      }
      return `<div class="candidate-row"><div><strong>${escapeHtml(folder)}</strong><span>之前选择了不提醒</span></div><div class="row-actions"><button data-action="ignore-register-folder" data-folder-path="${escapeHtml(folder)}">登记</button>${deleteButton}</div></div>`;
    }).filter(Boolean);
    const titleRows = ignoredRemoteTitleFormats.map((item, index) => `<div class="candidate-row"><div><strong>${escapeHtml(item.field)} ${escapeHtml(delimiterLabel(item.connector))}</strong><span>之前选择了不提醒</span></div><button data-action="ignore-register-title" data-ignore-index="${index}">登记</button></div>`);
    const rows = [...folderRows, ...titleRows];
    ui.ignoredDetails.hidden = false;
    ui.ignoredList.innerHTML = rows.length ? rows.join("") : '<div class="empty-state"><strong>这里是空的</strong><span>已经从本地删除的目录会自动从这里清掉。</span></div>';
    if (ui.ignoredCount) ui.ignoredCount.textContent = `${rows.length} 项`;
    if (ui.manageIgnoredButton) ui.manageIgnoredButton.hidden = !rows.length;
  }

  async function pruneMissingIgnoredFolders(root, audit) {
    if (!root || !audit?.folders || !ignoredFolders.length) return false;
    const present = new Set([...(audit.folders.JSON || []), ...(audit.folders.Markdown || [])]);
    const next = ignoredFolders.filter((folder) => present.has(folder));
    if (next.length === ignoredFolders.length) return false;
    const previous = [...ignoredFolders];
    ignoredFolders = next;
    try { await writeSharedClassificationRules(root); }
    catch (error) { ignoredFolders = previous; throw error; }
    return true;
  }

  async function removeEmptyLogicalFolder(root, kind, folderPath) {
    const parts = String(folderPath || "").split("/").filter(Boolean);
    if (!parts.length) return false;
    const directory = await getDirectory(root, joinPath(kind, ...parts), false);
    for await (const _entry of directory.values()) throw new Error(`${kind}/${folderPath} 不是空目录，已停止自动删除`);
    const name = parts.pop();
    const parent = await getDirectory(root, joinPath(kind, ...parts), false);
    await parent.removeEntry(name);
    return true;
  }

  async function applyFolderChange(root, change) {
    if (change.type === "create-mirror") {
      await getDirectory(root, joinPath(change.create_in, change.folder), true);
      return { type: change.type, folder: change.folder };
    }
    if (change.type === "delete-mirror") {
      try { await removeEmptyLogicalFolder(root, change.delete_in, change.folder); }
      catch (error) { if (error?.name !== "NotFoundError") throw error; }
      return { type: change.type, folder: change.folder };
    }
    return null;
  }

  async function ignoreEmptyFolderDecision(folderPath) {
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    const change = (ui?._folderAudit?.folderChanges || [])
      .find((item) => item.type === "decide-empty-folder" && item.folder === folderPath);
    if (!change) throw new Error("这个空目录状态已经变化，请重新检查一次");
    const previous = [...ignoredFolders];
    ignoredFolders = normalizeIgnoredFolders([...ignoredFolders, folderPath]);
    try { await writeSharedClassificationRules(directory.handle); }
    catch (error) { ignoredFolders = previous; throw error; }
    const audit = await refreshFolderDiscoveries({ interactive: false, announce: false });
    setStatus(`已先忽略：${folderPath}
它不会挡住后面的事项；可以从“之前忽略的项目”回来处理。`, "ok");
    return audit;
  }

  async function applyEmptyFolderDecision(folderPath, action) {
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    const change = (ui?._folderAudit?.folderChanges || [])
      .find((item) => item.type === "decide-empty-folder" && item.folder === folderPath);
    if (!change) throw new Error("这个空目录状态已经变化，请重新检查一次");
    if (action === "delete") {
      try { await removeEmptyLogicalFolder(directory.handle, change.present_in, change.folder); }
      catch (error) { if (error?.name !== "NotFoundError") throw error; }
    } else if (action === "mirror") {
      await getDirectory(directory.handle, joinPath(change.missing_in, change.folder), true);
    } else {
      throw new Error("未知的空目录处理方式");
    }
    const nextAudit = await auditExportFolders(directory.handle);
    await persistFolderState(directory.handle, folderSnapshotFromAudit(nextAudit));
    ui._folderAudit = nextAudit;
    renderFolderDiscoveries(nextAudit);
    setStatus(
      action === "delete"
        ? `空目录已删除：${change.folder}`
        : `已补齐：${change.folder}\nJSON 和 Markdown 现在都有这个目录。`,
      "ok",
    );
    return nextAudit;
  }

  async function settleDetectedLocalChanges(root, initialAudit, { statusPrefix = "正在处理本地变化" } = {}) {
    let audit = initialAudit;
    let conversationDone = 0;
    let folderDone = 0;
    const failures = [];
    if (audit.stateChangeResult?.trusted !== false) {
      const autoChanges = (audit.conversationChanges || []).filter((item) => ["move", "delete"].includes(item.type));
      for (const change of autoChanges) {
        try {
          setStatus(`${statusPrefix} ${conversationDone + 1}/${autoChanges.length}\n${change.title}`, "normal", true);
          if (change.type === "delete") await applyDetectedDelete(root, change);
          else await applyDetectedMove(root, change);
          conversationDone++;
        } catch (error) { failures.push(`${change.title}：${error.message || error}`); }
      }
      if (autoChanges.length) audit = await auditExportFolders(root);
    }

    // 空目录没有 conversation_id，所以单独按“上次两边都有 / 现在只剩一边”的状态判断。
    // 最多循环 4 次，处理嵌套空目录从叶子到父目录的连锁变化。
    for (let pass = 0; pass < 4; pass++) {
      const folderChanges = (audit.folderChanges || []).filter((item) => item.type === "create-mirror");
      if (!folderChanges.length) break;
      let changedThisPass = 0;
      const ordered = [...folderChanges].sort((a, b) => {
        if (a.type === b.type) return b.folder.split("/").length - a.folder.split("/").length;
        return a.type === "delete-mirror" ? -1 : 1;
      });
      for (const change of ordered) {
        try {
          await applyFolderChange(root, change);
          folderDone++;
          changedThisPass++;
        } catch (error) { failures.push(`${change.folder}：${error.message || error}`); }
      }
      if (!changedThisPass) break;
      audit = await auditExportFolders(root);
    }
    const hasPendingFolderDecision = (audit.folderChanges || []).some((item) => item.type === "decide-empty-folder");
    // 有待用户选择的空目录时保留旧基线；否则下一次扫描会失去“之前两边都有”的证据。
    if (!failures.length && !hasPendingFolderDecision) await persistFolderState(root, folderSnapshotFromAudit(audit));
    return { audit, conversationDone, folderDone, failures };
  }

  async function refreshFolderDiscoveries({ interactive = false, announce = false, autoApply = false } = {}) {
    const directory = await getAuthorizedDirectory(interactive);
    if (!directory.handle) {
      if (announce) setStatus(`无法检查本地文件：${directory.reason}`, "warning");
      return null;
    }
    await ensureArchiveStructure(directory.handle);
    await readSharedClassificationRules(directory.handle);
    if (announce) setStatus("正在检查本地文件……", "normal", true);
    let audit = await auditExportFolders(directory.handle, ({ scannedFiles, path }) => {
      if (announce && (scannedFiles === 1 || scannedFiles % 20 === 0)) {
        setStatus(`正在检查：${scannedFiles} 个文件\n${path}`, "normal", true);
      }
    });

    let settled = { audit, conversationDone: 0, folderDone: 0, failures: [] };
    if (autoApply && audit.stateChangeResult?.trusted !== false) {
      settled = await settleDetectedLocalChanges(directory.handle, audit);
      audit = settled.audit;
    }
    try { await pruneMissingIgnoredFolders(directory.handle, audit); }
    catch (error) { settled.failures.push(`清理已不存在的忽略目录：${error.message || error}`); }
    ui._folderAudit = audit;
    renderFolderDiscoveries(audit);

    if (announce) {
      const pending = managePendingCounts(audit);
      const autoParts = [];
      if (settled.conversationDone) autoParts.push(`${settled.conversationDone} 个对话变化`);
      if (settled.folderDone) autoParts.push(`${settled.folderDone} 个目录变化`);
      const autoText = autoParts.length ? `\n已自动处理：${autoParts.join("、")}` : "";
      const failureText = settled.failures.length ? `\n有 ${settled.failures.length} 项没处理成功。` : "";
      setStatus(
        pending.total
          ? `检查完成${autoText}\n还有 ${pending.total} 件事需要你看一下。${failureText}`
          : `检查完成${autoText || "\n没有需要处理的变化。"}${failureText}`,
        pending.blocking || settled.failures.length ? "warning" : "ok",
      );
    }
    updateManageHomeSummary(audit);
    return audit;
  }

  async function applySelectedConversationRule() {
    const preview = buildSelectedMigrationPreview();
    if (!window.confirm(`${preview.text}\n\n确认后会同时整理 JSON 和 Markdown，确认新位置没问题后再清理旧副本。`)) return;
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    const latestRule = classificationRules.find((item) => item.rule_id === preview.rule.rule_id);
    if (!latestRule) throw new Error("目标规则已被其他写入者删除，请重新扫描");
    const result = await migrateSelectedConversations(
      directory.handle, preview.ids, latestRule, ui._folderAudit?.conversationIssues || [],
    );
    await refreshFolderDiscoveries({ interactive: false, announce: false });
    setStatus(
      `整理完成\n成功：${result.migrated.length} 个\n失败：${result.failed.length} 个`
      + (result.failed.length ? `\n${result.failed.slice(0, 8).map((item) => `${item.title || item.conversation_id}：${item.reason}`).join("\n")}` : ""),
      result.failed.length ? "warning" : "ok",
    );
  }

  async function ignoreDiscoveredFolder(folderPath) {
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    const previous = ignoredFolders;
    ignoredFolders = normalizeIgnoredFolders([...ignoredFolders, folderPath]);
    try { await writeSharedClassificationRules(directory.handle); }
    catch (error) { ignoredFolders = previous; throw error; }
    await refreshFolderDiscoveries({ interactive: false, announce: false });
    renderIgnoredItems();
    setStatus(`已忽略目录建议：${folderPath}\n它以后不会再作为待登记项目提醒你。`, "ok");
  }

  async function removeEmptyDiscoveredFolder(folderPath) {
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    const presentIn = ui._folderAudit?.unregisteredFolders
      ?.find((item) => item.path === folderPath)?.present_in || ["JSON", "Markdown"];
    const targets = [];
    for (const kind of presentIn) {
      try {
        const handle = await getDirectory(directory.handle, joinPath(kind, folderPath), false);
        for await (const _entry of handle.values()) throw new Error(`${kind}/${folderPath} 不是空目录，不能删除`);
        targets.push({ kind, parts: folderPath.split("/").filter(Boolean) });
      } catch (error) {
        if (error?.name !== "NotFoundError") throw error;
      }
    }
    if (!targets.length) throw new Error("没有找到可删除的空目录");
    if (!window.confirm(`删除以下空目录？\n${targets.map((item) => `${item.kind}/${folderPath}`).join("\n")}\n\n只删除空目录，不删除任何文件。`)) return;
    for (const target of targets) {
      const name = target.parts.pop();
      const parent = await getDirectory(directory.handle, joinPath(target.kind, ...target.parts), false);
      await parent.removeEntry(name);
    }
    // 用户明确点了“删除空目录”，这就是新的可靠基线，避免旧 folder-state 把它再次补回来。
    try {
      const folderState = await loadFolderState(directory.handle);
      if (folderState?.folders) delete folderState.folders[folderPath];
      await persistFolderState(directory.handle, folderState);
    } catch { /* 删除动作本身已经完成；状态文件更新失败不反向恢复目录 */ }
    await refreshFolderDiscoveries({ interactive: false, announce: false });
    setStatus(`空目录已删除：${folderPath}`, "ok");
  }

  function openRuleEditorAndJump() {
    if (!ui?.ruleDetails) return;
    setManageScene("rule-editor", 1, { focus: ui.ruleField });
  }

  function prefillRuleFromFolder(folderPath, { returnScene = "discover" } = {}) {
    const draft = folderRuleDraft(folderPath);
    if (!draft.root_folder) throw new Error("无法识别这个文件夹路径");
    resetRuleForm();
    ui.ruleField.value = draft.suggested_field;
    ui.ruleRootFolder.value = draft.root_folder;
    if (ui.ruleRootFolderChoice) ui.ruleRootFolderChoice.value = draft.root_folder;
    ui.ruleSubfolderPath.value = draft.subfolder_path;
    populateRuleSubfolderChoices();
    setDelimiterForm(ui.ruleConnector, ui.ruleConnectorCustom, " ");
    setDelimiterForm(ui.ruleFolderSeparator, ui.ruleFolderSeparatorCustom, draft.folder_separator);
    ui._discoveredFolderPath = draft.path;
    ui._ruleReturnScene = returnScene;
    if (ui.ruleBackButton) ui.ruleBackButton.textContent = returnScene === "ignored" ? "‹ 之前忽略的项目" : "‹ 发现新目录";
    ui.ruleSave.textContent = "应用规则、补齐双侧文件夹并迁移";
    updateRulePreview();
    openRuleEditorAndJump();
    setStatus(`正在登记“${draft.path}”
当前页面就是分类设置；保存后会自动继续下一项。`, "normal");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function delimiterFromForm(select, customInput) {
    const selected = select?.value;
    if (selected === "__unset__") return null;
    if (selected === "__none__") return "";
    if (selected === "__space__") return " ";
    if (selected === "__custom__") return String(customInput?.value || "");
    return String(selected || "");
  }

  function setDelimiterForm(select, customInput, value) {
    if (value === null || value === undefined) select.value = "__unset__";
    else if (value === "") select.value = "__none__";
    else if (value === " ") select.value = "__space__";
    else if (Array.from(select.options).some((option) => option.value === value)) select.value = value;
    else {
      select.value = "__custom__";
      customInput.value = value;
    }
    customInput.hidden = select.value !== "__custom__";
  }

  function ruleFromForm() {
    const editing = classificationRules.find((item) => item.rule_id === ui._editingRuleId);
    const connector = delimiterFromForm(ui.ruleConnector, ui.ruleConnectorCustom);
    const folderSeparator = delimiterFromForm(ui.ruleFolderSeparator, ui.ruleFolderSeparatorCustom);
    const aliases = editing?.aliases ? [...editing.aliases] : [];
    if (editing && ui.keepOldAlias?.checked && !editing.format_pending) {
      const oldSignature = `${editing.field}\u0000${editing.connector}`;
      const nextSignature = `${String(ui.ruleField?.value || "").trim().toUpperCase()}\u0000${connector}`;
      if (oldSignature !== nextSignature) {
        aliases.push({ field: editing.field, connector: editing.connector });
      }
    } else if (editing && !ui.keepOldAlias?.checked) {
      aliases.length = 0;
    }
    return normalizeRule({
      rule_id: editing?.rule_id || makeRuleId(),
      field: ui.ruleField?.value,
      connector,
      root_folder: ui.ruleRootFolder?.value,
      folder_separator: folderSeparator,
      subfolder_path: ui.ruleSubfolderPath?.value,
      aliases,
    });
  }

  function titleTemplateForRule(rule) {
    if (!rule || rule.format_pending) return "";
    return `${rule.field}${delimiterLabel(rule.connector, "无连接符")}{对话名称}`;
  }

  function updateRulePreview() {
    if (!ui?.rulePreview) return;
    const selectedFolderSeparator = delimiterFromForm(ui.ruleFolderSeparator, ui.ruleFolderSeparatorCustom);
    if (ui.ruleSubfolderField) ui.ruleSubfolderField.hidden = selectedFolderSeparator === null || selectedFolderSeparator === "";
    const rule = ruleFromForm();
    const validation = validateRule(rule);
    if (!validation.ok) {
      ui.rulePreview.textContent = `最终导出位置预览\n\n尚不能预览：${validation.errors.join("；")}`;
      ui.rulePreview.dataset.kind = "error";
      return;
    }
    const subfolders = parseSubfolderPath(rule);
    const filename = `${cleanSegment(`${rule.field}${rule.connector}{对话名称}`, "对话名称")}__{ID}`;
    const folderPath = joinPath(rule.root_folder, ...subfolders.parts);
    const lines = [
      "最终导出位置预览",
      "",
      `对话标题：${titleTemplateForRule(rule)}`,
      "",
      `JSON/${folderPath}/${filename}.json`,
      `Markdown/${folderPath}/${filename}.md`,
    ];
    ui.rulePreview.dataset.kind = "ok";
    ui.rulePreview.textContent = lines.join("\n");
  }

  function renderClassificationRules() {
    if (!ui?.rulesList) return;
    ui.rulesList.innerHTML = classificationRules.length
      ? classificationRules.map((rule) => {
        const format = rule.format_pending ? "格式待确认" : ruleFormat(rule);
        const alias = rule.aliases.length ? `｜兼容旧格式 ${rule.aliases.length} 个` : "";
        const subfolders = parseSubfolderPath(rule);
        const destination = subfolders.ok ? joinPath(rule.root_folder, ...subfolders.parts) : rule.root_folder;
        return `<button class="rule-row" data-action="rule-edit" data-rule-id="${escapeHtml(rule.rule_id)}">
          <span class="rule-main"><strong>${escapeHtml(format)}</strong><span>${escapeHtml(destination)}${escapeHtml(alias)}</span></span>
          <span class="chevron">›</span>
        </button>`;
      }).join("")
      : '<div class="empty-state"><strong>还没有分类规则</strong><span>未匹配的对话会继续放在“未归类”。</span></div>';
    if (ui.ruleCount) ui.ruleCount.textContent = `${classificationRules.length} 条`;
  }

  async function addClassificationRule() {
    const sourceFolder = String(ui?._discoveredFolderPath || "").trim();
    let sourceConversationIds = sourceFolder ? conversationIdsInFolder(ui?._folderAudit?.observedFiles || [], sourceFolder) : [];
    const rule = ruleFromForm();
    const validation = validateRule(rule);
    if (!validation.ok) throw new Error(validation.errors.join("；"));
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(`规则尚未保存：${directory.reason}`);
    await readSharedClassificationRules(directory.handle);
    if (sourceFolder) sourceConversationIds = await conversationIdsDirectlyInFolder(directory.handle, sourceFolder);
    const conflict = classificationRules.find((item) =>
      item.rule_id !== rule.rule_id
      && !item.format_pending
      && item.field === rule.field
      && item.connector === rule.connector);
    if (conflict) throw new Error(`规则冲突：${rule.field}${delimiterLabel(rule.connector, "无连接符")} 已经被另一条规则使用`);
    const previous = classificationRules.find((item) => item.rule_id === rule.rule_id);
    const targetSubfolders = parseSubfolderPath(rule).parts;
    const targetFolder = joinPath(rule.root_folder, ...targetSubfolders);
    const previousSubfolders = previous ? parseSubfolderPath(previous).parts : [];
    const previousFolder = previous ? joinPath(previous.root_folder, ...previousSubfolders) : "";
    if (previous && previousFolder !== targetFolder) {
      const previousParent = previousFolder.split("/").slice(0, -1).join("/");
      const nextParent = targetFolder.split("/").slice(0, -1).join("/");
      const operation = previousParent === nextParent ? "重命名文件夹" : "移动到新的嵌套位置";
      if (!window.confirm(`${operation}\n旧位置：${previousFolder}\n新位置：${targetFolder}\n\n保存后，下一次同步会逐个校验并迁移相关对话。`)) return;
    }
    await getDirectory(directory.handle, joinPath("JSON", targetFolder), true);
    await getDirectory(directory.handle, joinPath("Markdown", targetFolder), true);
    await refreshRuleFolderChoices({ interactive: false });
    const previousRules = classificationRules;
    const previousOverrides = { ...classificationOverrides };
    const previousIgnoredFolders = [...ignoredFolders];
    const nextRules = [
      ...classificationRules.filter((item) => item.rule_id !== rule.rule_id),
      rule,
    ];
    saveClassificationRules(nextRules);
    if (sourceFolder) {
      ignoredFolders = ignoredFolders.filter((folder) => folder !== sourceFolder);
      for (const conversationId of sourceConversationIds) {
        classificationOverrides[conversationId] = {
          rule_id: rule.rule_id,
          folder: targetFolder,
          source: "manual-folder",
          updated_at: new Date().toISOString(),
        };
      }
    }
    try { await writeSharedClassificationRules(directory.handle); }
    catch (error) {
      classificationOverrides = previousOverrides;
      ignoredFolders = previousIgnoredFolders;
      saveClassificationRules(previousRules);
      throw error;
    }
    if (ui?._remoteRuleCandidates?.length) {
      ui._remoteRuleCandidates = ui._remoteRuleCandidates.filter((candidate) =>
        ignoredTitleFormatKey(candidate.field, candidate.connector) !== ignoredTitleFormatKey(rule.field, rule.connector));
      renderRemoteRuleCandidates(ui._remoteRuleCandidates);
    }
    setStatus(`规则已保存，正在处理标题匹配和已有明确分类的对话……`, "normal", true);
    const migration = await migrateLocalConversationsForRule(directory.handle, rule);
    resetRuleForm();
    await refreshFolderDiscoveries({ interactive: false, announce: false });
    setStatus(
      `规则已保存：${ruleFormat(rule)}\n目标文件夹：${targetFolder}\nJSON 和 Markdown 文件夹均已创建。`
      + (sourceConversationIds.length ? `\n这个目录里已有 ${sourceConversationIds.length} 个对话，已把它们一起登记到这条规则。` : "")
      + `\n已成对迁移或补齐：${migration.migrated.length} 个对话。`
      + (migration.failed.length ? `\n未能自动处理：${migration.failed.length} 个\n${migration.failed.slice(0, 8).join("\n")}` : "")
      + `\n不会修改 ChatGPT 网页端标题。`,
      migration.failed.length ? "warning" : "ok",
    );
  }

  function resetRuleForm() {
    ui.ruleField.value = "";
    ui.ruleRootFolder.value = "";
    ui.ruleSubfolderPath.value = "";
    if (ui.ruleRootFolderChoice) ui.ruleRootFolderChoice.value = "";
    if (ui.ruleSubfolderChoice) ui.ruleSubfolderChoice.value = "";
    setDelimiterForm(ui.ruleConnector, ui.ruleConnectorCustom, null);
    setDelimiterForm(ui.ruleFolderSeparator, ui.ruleFolderSeparatorCustom, null);
    ui.keepOldAlias.checked = false;
    ui._editingRuleId = "";
    ui._discoveredFolderPath = "";
    ui._ruleReturnScene = "rules";
    ui.ruleSave.textContent = "新增规则并创建文件夹";
    if (ui.ruleDeleteCurrent) { ui.ruleDeleteCurrent.textContent = "取消"; ui.ruleDeleteCurrent.classList.remove("btn-danger"); }
    if (ui.ruleBackButton) ui.ruleBackButton.textContent = "‹ 分类规则";
    updateRulePreview();
  }

  function clearStatus() {
    if (!ui?.status) return;
    ui.status.hidden = true;
    ui.status.textContent = "";
    ui.cancel.hidden = true;
  }

  function cancelRuleEditor() {
    if (!ui) return;
    const sourceFolder = String(ui._discoveredFolderPath || "");
    const returnScene = ui._ruleReturnScene || (sourceFolder ? "discover" : "rules");
    resetRuleForm();
    clearStatus();
    if (returnScene === "discover") {
      renderFolderDiscoveries(ui._folderAudit);
      setManageScene((ui?._folderAudit?.unregisteredFolders || []).length ? "discover" : "home", -1);
      return;
    }
    if (returnScene === "ignored") {
      renderIgnoredItems();
      setManageScene("ignored", -1);
      return;
    }
    renderClassificationRules();
    setManageScene("rules", -1);
  }

  function editClassificationRule(ruleId) {
    const rule = classificationRules.find((item) => item.rule_id === ruleId);
    if (!rule) throw new Error(`找不到规则：${ruleId}`);
    ui.ruleField.value = rule.field;
    ui.ruleRootFolder.value = rule.root_folder;
    ui.ruleSubfolderPath.value = rule.subfolder_path || "";
    if (ui.ruleRootFolderChoice) ui.ruleRootFolderChoice.value = rule.root_folder;
    populateRuleSubfolderChoices();
    setDelimiterForm(ui.ruleConnector, ui.ruleConnectorCustom, rule.connector);
    setDelimiterForm(ui.ruleFolderSeparator, ui.ruleFolderSeparatorCustom, rule.folder_separator);
    ui.keepOldAlias.checked = rule.aliases.length > 0;
    ui._editingRuleId = rule.rule_id;
    ui._ruleReturnScene = "rules";
    if (ui.ruleBackButton) ui.ruleBackButton.textContent = "‹ 分类规则";
    ui.ruleSave.textContent = "保存修改并准备安全迁移";
    if (ui.ruleDeleteCurrent) { ui.ruleDeleteCurrent.textContent = "删除这条规则"; ui.ruleDeleteCurrent.classList.add("btn-danger"); }
    updateRulePreview();
    openRuleEditorAndJump();
    setStatus(
      rule.format_pending
        ? `旧规则 ${rule.field} 的字段和根文件夹已保留。请选择设置；使用子文件夹时还要填写子文件夹名称。`
        : `正在编辑规则 ${rule.field}。修改子文件夹名称时，绿色框会立即显示新的完整路径。`,
      rule.format_pending ? "warning" : "normal",
    );
  }

  async function deleteClassificationRule(ruleId) {
    const rule = classificationRules.find((item) => item.rule_id === ruleId);
    if (!rule) throw new Error(`找不到规则：${ruleId}`);
    if (!window.confirm(`删除规则 ${rule.field}？本地已经导出的文件不会被删除。`)) return;
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(`规则尚未删除：${directory.reason}`);
    await readSharedClassificationRules(directory.handle);
    const previousRules = classificationRules;
    const previousOverrides = classificationOverrides;
    const nextOverrides = { ...classificationOverrides };
    saveClassificationRules(classificationRules.filter((item) => item.rule_id !== ruleId));
    for (const [conversationId, override] of Object.entries(nextOverrides)) {
      if (override.rule_id === ruleId) delete nextOverrides[conversationId];
    }
    classificationOverrides = nextOverrides;
    try { await writeSharedClassificationRules(directory.handle); }
    catch (error) {
      classificationOverrides = previousOverrides;
      saveClassificationRules(previousRules);
      throw error;
    }
    if (ui._editingRuleId === ruleId) resetRuleForm();
    await refreshFolderDiscoveries({ interactive: false, announce: false });
    setStatus(`分类规则已删除：${rule.field}。本地文件未删除。`, "warning");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchWithRetry(url, options = {}, retries = 3) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (cancelRequested) throw new Error("用户已取消同步");
      try {
        const response = await fetch(url, options);
        if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) return response;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < retries) await sleep(Math.min(8000, 600 * (2 ** attempt)) + Math.floor(Math.random() * 250));
    }
    throw lastError || new Error("网络请求失败");
  }

  async function getSession() {
    try {
      const response = await fetchWithRetry("/api/auth/session", {
        credentials: "include", headers: { Accept: "application/json" }, cache: "no-store",
      }, 1);
      if (!response.ok) return { ok: false, status: response.status, token: null };
      const data = await response.json();
      return { ok: Boolean(data?.user || data?.accessToken || data?.access_token), status: response.status, token: data?.accessToken || data?.access_token || null };
    } catch (error) {
      return { ok: false, status: 0, token: null, error: error.message };
    }
  }

  function authHeaders(token) {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function fetchConversation(conversationId, token) {
    const errors = [];
    for (const base of ["/backend-api/conversation/", "/api/conversation/"]) {
      const endpoint = `${base}${encodeURIComponent(conversationId)}`;
      try {
        const response = await fetchWithRetry(endpoint, {
          credentials: "include", headers: authHeaders(token), cache: "no-store",
        });
        if (!response.ok) {
          errors.push(`${endpoint}: HTTP ${response.status}`);
          continue;
        }
        const data = await response.json();
        if (data?.mapping && data?.current_node) return { data, endpoint };
        errors.push(`${endpoint}: 缺少 mapping/current_node`);
      } catch (error) {
        errors.push(`${endpoint}: ${error.message}`);
      }
    }
    throw new Error(errors.join("；"));
  }

  async function fetchInventoryMode(token, archived) {
    const limit = 100;
    const errors = [];

    // 同一次分页扫描固定使用同一个 endpoint。
    // 如果该 endpoint 整轮失败，只能从 offset=0 改用备用 endpoint 重新扫描，
    // 禁止把两个 endpoint 的分页结果拼成一个目录。
    for (const base of ["/backend-api/conversations", "/api/conversations"]) {
      try {
        const result = await fetchAllPages({
          limit,
          fetchPage: async ({ offset }) => {
            const query = new URLSearchParams({
              offset: String(offset),
              limit: String(limit),
              order: "updated",
              is_archived: String(archived),
            });
            const endpoint = `${base}?${query}`;
            const response = await fetchWithRetry(endpoint, {
              credentials: "include", headers: authHeaders(token), cache: "no-store",
            }, 2);
            if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
            const data = await response.json();
            const items = Array.isArray(data) ? data : data?.items;
            if (!Array.isArray(items)) throw new Error(`${endpoint}: 缺少 items`);
            return { items, total: Number.isFinite(Number(data?.total)) ? Number(data.total) : null };
          },
        });
        return { ...result, endpoint: base };
      } catch (error) {
        errors.push(`${base}: ${error.message}`);
      }
    }

    throw new Error(errors.join("；"));
  }

  function normalizeInventoryItem(item, archived) {
    return {
      ...item,
      id: String(item?.id || item?.conversation_id || ""),
      title: item?.title || "未命名对话",
      create_time: item?.create_time || item?.inserted_at || null,
      update_time: item?.update_time || item?.updated_at || null,
      archived: Boolean(archived),
    };
  }

  async function fetchCompleteInventory(token) {
    const normal = await fetchInventoryMode(token, false);
    let archived = { items: [], total: 0, supported: true };
    let archivedBoundary = "";
    try {
      const result = await fetchInventoryMode(token, true);
      archived = { ...result, supported: true, paginationComplete: true };
      const normalIds = new Set(normal.items.map((item) => String(item?.id || item?.conversation_id || "")));
      const archivedIds = result.items.map((item) => String(item?.id || item?.conversation_id || ""));
      if (archivedIds.length > 0 && archivedIds.length === normalIds.size && archivedIds.every((id) => normalIds.has(id))) {
        archived = { items: [], total: null, supported: false };
        archivedBoundary = "归档参数返回了与普通目录完全相同的结果，无法确认接口支持归档筛选";
      }
    } catch (error) {
      const paginationFailure = /分页不完整/.test(error.message || "");
      archived = { items: [], total: null, supported: paginationFailure, paginationComplete: !paginationFailure };
      archivedBoundary = paginationFailure
        ? `归档目录分页失败：${error.message}`
        : `归档目录不可访问：${error.message}`;
    }
    const map = new Map();
    for (const item of normal.items.map((x) => normalizeInventoryItem(x, false))) if (item.id) map.set(item.id, item);
    for (const item of archived.items.map((x) => normalizeInventoryItem(x, true))) if (item.id) map.set(item.id, item);
    return { items: Array.from(map.values()), normal, archived, archivedBoundary };
  }

  const platformAdapters = [];

  function registerPlatformAdapter(adapter) {
    const validation = validatePlatformAdapter(adapter);
    if (!validation.ok) throw new Error(`平台适配器缺少：${validation.missing.join(", ")}`);
    if (platformAdapters.some((item) => item.id === adapter.id)) throw new Error(`平台适配器重复：${adapter.id}`);
    platformAdapters.push(Object.freeze(adapter));
  }

  function resolvePlatformAdapter(pageLocation = window.location) {
    const adapter = platformAdapters.find((item) => item.matches(pageLocation));
    if (!adapter) throw new Error(`当前网站没有适配器：${pageLocation.hostname}`);
    return adapter;
  }

  registerPlatformAdapter({
    id: "chatgpt",
    displayName: "ChatGPT",
    matches: (pageLocation) => ["chatgpt.com", "chat.openai.com"].includes(pageLocation.hostname),
    getConversationId: (pageLocation) => extractConversationId(pageLocation.pathname),
    getSession,
    fetchInventory: fetchCompleteInventory,
    fetchConversation,
  });

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(IDB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbGetStoredHandle(key) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }

  async function idbSetStoredHandle(key, handle) {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const request = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(handle, key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }

  async function idbGetHandle() { return idbGetStoredHandle(IDB_HANDLE_KEY); }
  async function idbSetHandle(handle) { return idbSetStoredHandle(IDB_HANDLE_KEY, handle); }

  async function idbClear() {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const request = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }

  async function verifyPermission(handle, request = false) {
    if (!handle) return false;
    const options = { mode: "readwrite" };
    if ((await handle.queryPermission(options)) === "granted") return true;
    return request && (await handle.requestPermission(options)) === "granted";
  }

  async function chooseDirectory() {
    if (typeof window.showDirectoryPicker !== "function") throw new Error("当前浏览器不支持 File System Access API（showDirectoryPicker）");
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "chatgpt-local-export-root" });
    if (!(await verifyPermission(handle, true))) throw new Error("未获得导出目录读写权限");
    await idbSetHandle(handle);
    cachedDirectoryHandle = handle;
    directoryHandleLoaded = true;
    await ensureArchiveStructure(handle);
    updateDirectoryDisplay();
    return handle;
  }

  async function getAuthorizedDirectory(interactive = false) {
    if (typeof window.showDirectoryPicker !== "function") return { handle: null, reason: "浏览器不支持 File System Access API" };
    if (!directoryHandleLoaded) {
      if (interactive) {
        const selected = await chooseDirectory();
        return { handle: selected, reason: "" };
      }
      cachedDirectoryHandle = await idbGetHandle();
      directoryHandleLoaded = true;
    }
    let handle = cachedDirectoryHandle;
    if (handle && await verifyPermission(handle, interactive)) return { handle, reason: "" };
    if (interactive) {
      handle = await chooseDirectory();
      return { handle, reason: "" };
    }
    return { handle: null, reason: handle ? "导出目录权限需要重新授权" : "尚未选择导出目录" };
  }

  async function getDirectory(root, relativePath, create = false) {
    let current = root;
    for (const segment of String(relativePath || "").split("/").filter(Boolean)) {
      current = await current.getDirectoryHandle(segment, { create });
    }
    return current;
  }

  async function migrateLegacySystemFolder(root, legacyName, currentName) {
    let source;
    try { source = await getDirectory(root, legacyName, false); }
    catch (error) {
      if (error?.name === "NotFoundError") return { moved: 0, conflicts: [] };
      throw error;
    }
    const files = [];
    for await (const entry of walkDirectory(source)) files.push(entry);
    let moved = 0;
    const conflicts = [];
    for (const entry of files) {
      if (!/\.(?:json|md)$/i.test(entry.path)) {
        conflicts.push(`${legacyName}/${entry.path}：不是 JSON/Markdown，已保留原文件`);
        continue;
      }
      const sourcePath = joinPath(legacyName, entry.path);
      const destinationPath = joinPath(currentName, entry.path);
      const sourceText = await (await entry.handle.getFile()).text();
      const existingText = await readText(root, destinationPath);
      if (existingText !== null && existingText !== sourceText) {
        conflicts.push(`${sourcePath}：中文目录已有不同内容，未覆盖`);
        continue;
      }
      if (existingText === null) await writeText(root, destinationPath, sourceText);
      try { await removeFile(root, sourcePath); } catch (error) {
        if (error?.name !== "NotFoundError") throw error;
      }
      moved++;
    }
    if (!conflicts.length) {
      try { await root.removeEntry(legacyName, { recursive: true }); }
      catch (error) { if (error?.name !== "NotFoundError") conflicts.push(`${legacyName}：旧目录未能清理（${error.message || error}）`); }
    }
    return { moved, conflicts };
  }

  async function ensureArchiveStructure(root) {
    if (!root) return { moved: 0, conflicts: [] };
    for (const path of [
      `JSON/${SYSTEM_INBOX_FOLDER}`,
      `Markdown/${SYSTEM_INBOX_FOLDER}`,
      `${SYSTEM_ARCHIVE_FOLDER}/JSON`, `${SYSTEM_ARCHIVE_FOLDER}/Markdown`,
      `${SYSTEM_DELETED_FOLDER}/JSON`, `${SYSTEM_DELETED_FOLDER}/Markdown`,
      EXTRACTION_HISTORY_FOLDER,
      META_DIR,
    ]) await getDirectory(root, path, true);
    const archiveMigration = await migrateLegacySystemFolder(root, LEGACY_ARCHIVE_FOLDER, SYSTEM_ARCHIVE_FOLDER);
    const deletedMigration = await migrateLegacySystemFolder(root, LEGACY_DELETED_FOLDER, SYSTEM_DELETED_FOLDER);
    return {
      moved: archiveMigration.moved + deletedMigration.moved,
      conflicts: [...archiveMigration.conflicts, ...deletedMigration.conflicts],
    };
  }

  function updateDirectoryDisplay() {
    if (!ui) return;
    const label = cachedDirectoryHandle?.name ? `当前资料库：${cachedDirectoryHandle.name}` : "尚未选择本地资料库";
    for (const element of [ui.exportDirectoryName, ui.manageDirectoryName, ui.extractDirectoryName]) {
      if (element) element.textContent = label;
    }
    if (ui.extractHistoryLocation) updateExtractionOutputDisplay();
  }

  async function getFileHandle(root, relativePath, create = false) {
    const parts = String(relativePath).split("/").filter(Boolean);
    const filename = parts.pop();
    const directory = await getDirectory(root, parts.join("/"), create);
    return directory.getFileHandle(filename, { create });
  }

  async function readText(root, path) {
    try {
      const handle = await getFileHandle(root, path, false);
      return await (await handle.getFile()).text();
    } catch (error) {
      if (error?.name === "NotFoundError") return null;
      throw error;
    }
  }

  async function readJson(root, path) {
    const text = await readText(root, path);
    if (text === null) return null;
    return JSON.parse(text);
  }

  async function writeText(root, path, text) {
    const handle = await getFileHandle(root, path, true);
    const writable = await handle.createWritable();
    try {
      await writable.write(text);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch { /* noop */ }
      throw error;
    }
  }

  async function writeJson(root, path, value) {
    await writeText(root, path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function writeBinary(root, path, bytes) {
    const parts = String(path).split("/").filter(Boolean);
    const filename = parts.pop();
    if (!filename) throw new Error("二进制输出路径缺少文件名");
    const directory = await getDirectory(root, parts.join("/"), true);
    const fileHandle = await directory.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch { /* noop */ }
      throw error;
    }
  }


  async function removeFile(root, path) {
    const parts = String(path).split("/").filter(Boolean);
    const filename = parts.pop();
    const directory = await getDirectory(root, parts.join("/"), false);
    await directory.removeEntry(filename);
  }

  async function removeEmptyAncestorDirectories(root, filePath) {
    const parts = String(filePath || "").split("/").filter(Boolean);
    parts.pop();
    while (parts.length > 1) {
      const directoryPath = parts.join("/");
      const directory = await getDirectory(root, directoryPath, false);
      let empty = true;
      for await (const _entry of directory.values()) {
        empty = false;
        break;
      }
      if (!empty) break;
      const name = parts.pop();
      const parent = await getDirectory(root, parts.join("/"), false);
      await parent.removeEntry(name);
    }
  }

  function directoryIo(root) {
    return {
      readJson: (path) => readJson(root, path),
      readText: (path) => readText(root, path),
      writeJson: (path, value) => writeJson(root, path, value),
      writeText: (path, value) => writeText(root, path, value),
      exists: async (path) => (await readText(root, path)) !== null,
      remove: (path) => removeFile(root, path),
    };
  }

  function emptyIndex() {
    return { schema_version: INDEX_SCHEMA_VERSION, exporter_version: VERSION, updated_at: null, conversations: {} };
  }

  async function loadIndex(root) {
    const internal = await readJson(root, `${META_DIR}/index.json`);
    if (internal?.conversations && typeof internal.conversations === "object") return internal;
    return null;
  }

  function titleFromObservedPaths(observed = {}) {
    const path = observed.markdown?.[0] || observed.json?.[0] || "";
    const filename = normalizeStatePath(path).split("/").pop() || "";
    return filename.replace(/\.(?:md|json)$/i, "").replace(/__[A-Za-z0-9_-]{4,}$/i, "") || "未命名对话";
  }

  async function ensureConversationState(root, index = null, observedFiles = []) {
    const rawState = await readJson(root, CONVERSATION_STATE_PATH);
    const rawDeleted = await readJson(root, DELETED_CONVERSATIONS_PATH);
    if (rawState !== null && (!rawState?.conversations || typeof rawState.conversations !== "object")) {
      throw new Error("conversation-state.json 已存在但格式无效；为避免覆盖，已停止状态初始化");
    }
    if (rawDeleted !== null && (!rawDeleted?.deleted || typeof rawDeleted.deleted !== "object")) {
      throw new Error("deleted-conversations.json 已存在但格式无效；为避免覆盖，已停止状态初始化");
    }
    const stateExisted = rawState !== null;
    const deletedExisted = rawDeleted !== null;
    let state = normalizeConversationState(rawState);
    let deleted = normalizeDeletedConversations(rawDeleted);
    let stateChanged = !stateExisted;
    const now = new Date().toISOString();
    const deletedIds = new Set(Object.keys(deleted.deleted));
    const entries = index?.conversations && typeof index.conversations === "object" ? index.conversations : {};

    for (const [conversationId, entry] of Object.entries(entries)) {
      if (!conversationId || deletedIds.has(conversationId) || state.conversations[conversationId]) continue;
      state.conversations[conversationId] = stateEntryFromIndexEntry(entry, now);
      stateChanged = true;
    }

    if (!stateExisted) {
      const observedById = buildObservedConversationMap(observedFiles);
      for (const [conversationId, observed] of observedById.entries()) {
        if (deletedIds.has(conversationId) || state.conversations[conversationId]) continue;
        state.conversations[conversationId] = normalizeStateEntry({
          title: titleFromObservedPaths(observed),
          state: "active",
          last_known: {
            json_path: observed.json[0] || "",
            markdown_path: observed.markdown[0] || "",
          },
          classification: null,
          baseline_at: now,
        });
        stateChanged = true;
      }
    }

    if (stateChanged) state = await persistConversationState(root, state);
    if (!deletedExisted) deleted = await persistDeletedConversations(root, deleted);
    return { state, deleted, created: !stateExisted, stateChanged };
  }

  async function refreshConversationStateFromIndex(root, index, conversationIds = null) {
    const state = await loadConversationState(root);
    const deleted = await loadDeletedConversations(root);
    const deletedIds = new Set(Object.keys(deleted.deleted));
    const ids = conversationIds ? new Set([...conversationIds].map(String)) : null;
    const now = new Date().toISOString();
    let changed = false;
    for (const [conversationId, entry] of Object.entries(index?.conversations || {})) {
      if (ids && !ids.has(conversationId)) continue;
      if (deletedIds.has(conversationId)) continue;
      state.conversations[conversationId] = stateEntryFromIndexEntry(entry, now);
      changed = true;
    }
    if (changed) await persistConversationState(root, state);
    return { state, changed };
  }

  async function* walkDirectory(directory, prefix = "") {
    for await (const [name, handle] of directory.entries()) {
      const path = joinPath(prefix, name);
      if (handle.kind === "directory") yield* walkDirectory(handle, path);
      else yield { path, handle };
    }
  }

  async function rebuildIndex(root, progress = () => {}) {
    const index = emptyIndex();
    const issues = [];
    let scanned = 0;
    for await (const entry of walkDirectory(root)) {
      if (cancelRequested) throw new Error("用户已取消操作");
      const topFolder = String(entry.path || "").split("/")[0];
      if ([SYSTEM_ARCHIVE_FOLDER, SYSTEM_DELETED_FOLDER, LEGACY_ARCHIVE_FOLDER, LEGACY_DELETED_FOLDER].includes(topFolder)) continue;
      if (!entry.path.toLowerCase().endsWith(".json") || entry.path.startsWith(`${META_DIR}/`) || ["conversation-index.json", "timeline.json"].includes(entry.path)) continue;
      scanned++;
      progress(`正在重建索引：已扫描 ${scanned} 个 JSON`);
      try {
        const data = JSON.parse(await (await entry.handle.getFile()).text());
        const id = String(data?.conversation_id || "");
        if (!id) {
          issues.push(`${entry.path}: 非本插件 JSON 或缺少 conversation_id`);
          continue;
        }
        const markdownPath = data.markdown_path || entry.path.replace(/^JSON\//, "Markdown/").replace(/\.json$/i, ".md");
        index.conversations[id] = {
          conversation_id: id, title: data.title || "未命名对话",
          create_time: data.create_time || null, update_time: data.update_time || null,
          message_count: Array.isArray(data.messages) ? data.messages.length : 0,
          export_revision: data.export_revision || null,
          json_path: entry.path, markdown_path: markdownPath,
          classification: data.classification || { kind: "未归类", name: "" },
        };
      } catch (error) {
        issues.push(`${entry.path}: ${error.message}`);
      }
    }
    index.updated_at = new Date().toISOString();
    await persistIndexes(root, index);
    return { index, issues, scanned, persisted: true };
  }

  function publicIndex(index) {
    return {
      schema_version: index.schema_version,
      exporter_version: index.exporter_version,
      updated_at: index.updated_at,
      conversations: Object.values(index.conversations).sort((a, b) => toTimestampMs(b.update_time) - toTimestampMs(a.update_time)),
    };
  }

  async function persistIndexes(root, index) {
    index.exporter_version = VERSION;
    index.updated_at = new Date().toISOString();
    await writeJson(root, "conversation-index.json", publicIndex(index));
    await writeJson(root, `${META_DIR}/index.json`, index);
  }

  function buildMarkdown(archive) {
    const yaml = (value) => String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const lines = [
      "---", `title: "${yaml(archive.title)}"`, `conversation_id: "${archive.conversation_id}"`,
      `create_time: "${archive.create_time || ""}"`, `update_time: "${archive.update_time || ""}"`,
      `message_count: ${archive.messages.length}`, `export_revision: "${archive.export_revision || ""}"`,
      `json_path: "${yaml(archive.json_path || "")}"`, `markdown_path: "${yaml(archive.markdown_path || "")}"`,
      `exporter_version: "${VERSION}"`, `schema_version: "${SCHEMA_VERSION}"`, "---", "",
    ];
    for (const message of archive.messages) {
      lines.push(`## ${message.role} · ${message.occurred_at || "时间缺失"}`, "", message.content || "（仅附件或引用）", "");
      if (message.files?.length) lines.push(`附件：${message.files.map((file) => file.name || file.id || "未知附件").join("、")}`, "");
    }
    if (archive.conversion_warnings?.length) {
      lines.push("## 转换警告", "", ...archive.conversion_warnings.map((warning) => `- ${warning}`), "");
    }
    return `${lines.join("\n").trim()}\n`;
  }

  async function readIndexedArchives(root, index) {
    const archives = [];
    const issues = [];
    for (const entry of Object.values(index.conversations)) {
      try {
        const archive = await readJson(root, entry.json_path);
        if (archive?.conversation_id) archives.push({ ...archive, _json_path: entry.json_path });
        else issues.push(`${entry.json_path}: 缺少 conversation_id`);
      } catch (error) {
        issues.push(`${entry.json_path}: ${error.message}`);
      }
    }
    return { archives, issues };
  }

  function planSummary(plan) {
    return `本地已有 ${plan.localCount}｜近期活跃 ${plan.active.length}｜待新增 ${plan.add.length}｜待更新 ${plan.update.length}｜跳过 ${plan.skip.length}｜时间未知 ${plan.unknown.length}`;
  }

  function buildReport(result) {
    const status = syncState({
      written: result.written, failures: result.failed,
      stageFailures: result.stageFailures || [], cancelled: result.cancelled,
      recoveries: result.recoveries || [],
    });
    const lines = [
      `# ChatGPT 本地同步报告`, "", `状态：${status}`, `同步时间：${result.finishedAt}`,
      `目录统计：${result.summary}`, `新增：${result.added}`, `更新：${result.updated}`,
      `跳过：${result.skipped}`, `失败：${result.failed.length}`, `保留较完整历史版本：${result.preserved}`,
    ];
    if (result.archivedBoundary) lines.push("", `能力边界：${result.archivedBoundary}`);
    if (result.warnings.length) lines.push("", "## 警告", "", ...result.warnings.map((x) => `- ${x}`));
    if (result.recoveries?.length) lines.push("", "## 旁路恢复", "", ...result.recoveries.map((x) => `- ${x.conversation_id}: 原路径 ${x.original_path}；恢复路径 ${x.recovery_path}；错误 ${x.parse_error}`));
    if (result.stageFailures?.length) lines.push("", "## 写入阶段失败", "", ...result.stageFailures.map((x) => `- ${x.stage}: ${x.reason}`));
    if (result.failed.length) lines.push("", "## 失败", "", ...result.failed.map((x) => `- ${x.id}: ${x.reason}`));
    return { status, markdown: `${lines.join("\n")}\n` };
  }

  async function appendHistory(root, record) {
    let history = [];
    try { history = await readJson(root, `${META_DIR}/sync-history.json`) || []; } catch { history = []; }
    if (!Array.isArray(history)) history = [];
    history.push(record);
    await writeJson(root, `${META_DIR}/sync-history.json`, history.slice(-500));
  }

  async function ensureIndex(root, force = false) {
    return loadOrRebuildIndex({
      load: async () => force ? null : loadIndex(root),
      rebuild: () => rebuildIndex(root, (text) => setStatus(text)),
    });
  }

  async function locateConversationCopies(root, conversationId) {
    const result = { json: [], markdown: [] };
    const suffix = `__${shortId(conversationId)}`.toLowerCase();
    for await (const entry of walkDirectory(root)) {
      const lower = entry.path.toLowerCase();
      if (!lower.includes(suffix)) continue;
      try {
        if (lower.startsWith("json/") && lower.endsWith(".json")) {
          const data = JSON.parse(await (await entry.handle.getFile()).text());
          if (String(data?.conversation_id || "") === String(conversationId)) result.json.push(entry.path);
        } else if (lower.startsWith("markdown/") && lower.endsWith(".md")) {
          const metadata = parseMarkdownMetadata(await (await entry.handle.getFile()).text());
          if (String(metadata?.conversation_id || "") === String(conversationId)) result.markdown.push(entry.path);
        }
      } catch {
        // 损坏或非本插件文件不参与自动迁移，也不会被删除。
      }
    }
    return result;
  }

  async function removeVerifiedConversationDuplicates(root, conversationId, keepPaths) {
    const copies = await locateConversationCopies(root, conversationId);
    const removed = [];
    for (const path of [...copies.json, ...copies.markdown]) {
      if (path === keepPaths.json || path === keepPaths.markdown) continue;
      await removeFile(root, path);
      removed.push(path);
      try { await removeEmptyAncestorDirectories(root, path); } catch { /* 非空目录保留 */ }
    }
    return removed;
  }

  async function migrateSelectedConversations(root, conversationIds, rule, issues = []) {
    const loaded = await ensureIndex(root, false);
    const index = loaded.index;
    const issueMap = new Map(issues.map((issue) => [issue.conversation_id, issue]));
    const migrated = [];
    const failed = [];
    const previousOverrides = classificationOverrides;
    const nextOverrides = { ...classificationOverrides };
    for (const conversationId of conversationIds) {
      nextOverrides[conversationId] = {
        rule_id: rule.rule_id, source: "user-selection", updated_at: new Date().toISOString(),
      };
    }
    classificationOverrides = nextOverrides;
    try { await writeSharedClassificationRules(root); }
    catch (error) { classificationOverrides = previousOverrides; throw error; }
    for (const [position, conversationId] of conversationIds.entries()) {
      if (cancelRequested) break;
      const issue = issueMap.get(conversationId);
      const entry = index.conversations[conversationId];
      setStatus(`正在整理 ${position + 1}/${conversationIds.length}\n${entry?.title || issue?.title || conversationId}`, "normal", true);
      try {
        const copies = issue
          ? { json: issue.json_paths, markdown: issue.markdown_paths }
          : await locateConversationCopies(root, conversationId);
        if (copies.json.length !== 1) throw new Error(copies.json.length ? "存在多个 JSON 副本，需要单独处理" : "缺少可读取的 JSON，需先从网页同步补齐");
        if (copies.markdown.length > 1) throw new Error("存在多个 Markdown 副本，需要单独处理");
        const archive = await readJson(root, copies.json[0]);
        if (String(archive?.conversation_id || "") !== String(conversationId)) throw new Error("源 JSON conversation_id 校验失败");
        const title = entry?.title || archive.title || issue?.title || "未命名对话";
        const classification = classificationFromRule(rule, title, "user-selection");
        if (!classification) throw new Error("目标规则不可用");
        const desired = archivePaths(title, conversationId, classification);
        const oldEntry = {
          ...(entry || {}),
          conversation_id: conversationId, title,
          json_path: copies.json[0],
          markdown_path: copies.markdown[0] || entry?.markdown_path || desired.markdown,
        };
        const staged = await stageConversationWrite({
          io: directoryIo(root),
          freshArchive: { ...archive, title, exporter_version: VERSION, classification },
          oldEntry,
          markdownText: buildMarkdown,
        });
        if (staged.kind !== "staged") throw new Error(`源 JSON 无法安全读取，已写入恢复区：${staged.recovery_path}`);
        index.conversations[conversationId] = indexEntryFromArchive(staged.archive, staged.paths);
        await persistIndexes(root, index);
        staged.pending.stage = "index_written";
        await writeJson(root, staged.pending_path, staged.pending);
        const finalized = await recoverPendingCommit({
          io: directoryIo(root), pendingFile: staged.pending_path, record: staged.pending, index,
          renderMarkdown: buildMarkdown, persistIndex: (next) => persistIndexes(root, next),
        });
        if (!finalized.complete) throw new Error(`提交校验失败：${finalized.errors.join("；")}`);
        await removeVerifiedConversationDuplicates(root, conversationId, staged.paths);
        migrated.push({ conversation_id: conversationId, title, ...staged.paths });
      } catch (error) {
        failed.push({ conversation_id: conversationId, title: entry?.title || issue?.title || "", reason: error.message || String(error) });
      }
    }
    if (migrated.length) {
      const archives = await readIndexedArchives(root, index);
      if (!archives.issues.length) await writeJson(root, "timeline.json", timelineFromArchives(archives.archives));
      await refreshConversationStateFromIndex(root, index, migrated.map((item) => item.conversation_id));
    }
    return { migrated, failed, cancelled: cancelRequested };
  }

  async function migrateLocalConversationsForRule(root, rule) {
    const loaded = await ensureIndex(root, false);
    const index = loaded.index;
    const migrated = [];
    const failed = [];
    for (const originalEntry of Object.values(index.conversations)) {
      try {
        const copies = await locateConversationCopies(root, originalEntry.conversation_id);
        const copyFolders = [...copies.json, ...copies.markdown].map((path) => path.split("/").slice(1, -1).join("/"));
        const existingOverride = classificationOverrides[originalEntry.conversation_id];
        const fromTitle = classifyTitle(originalEntry.title, classificationRules);
        const titleMatches = fromTitle?.rule_id === rule.rule_id;
        if (existingOverride?.rule_id && existingOverride.rule_id !== rule.rule_id) continue;
        const overrideMatches = existingOverride?.rule_id === rule.rule_id;
        if (!titleMatches && !overrideMatches) continue;
        const registeredFolders = new Set(classificationRules.map(ruleTargetFolder).filter((folder) => copyFolders.includes(folder)));
        if (!overrideMatches && registeredFolders.size > 1) {
          throw new Error(`JSON 与 Markdown 位于多个已登记目录：${[...registeredFolders].join("、")}；请在整理列表中选择最终分类`);
        }
        const classification = overrideMatches
          ? classificationFromRule(rule, originalEntry.title, existingOverride.source || "user-selection")
          : fromTitle;
        const desired = archivePaths(originalEntry.title, originalEntry.conversation_id, classification);
        const actualJson = copies.json.includes(originalEntry.json_path)
          ? originalEntry.json_path
          : copies.json[0] || originalEntry.json_path;
        const actualMarkdown = copies.markdown.includes(originalEntry.markdown_path)
          ? originalEntry.markdown_path
          : copies.markdown[0] || originalEntry.markdown_path;
        const pathsAlreadyCorrect = actualJson === desired.json && actualMarkdown === desired.markdown;
        const classificationAlreadyCorrect = originalEntry.classification?.rule_id === rule.rule_id;
        if (pathsAlreadyCorrect && classificationAlreadyCorrect) continue;
        const archive = await readJson(root, actualJson);
        if (!archive?.conversation_id) throw new Error(`找不到可读取的 JSON：${actualJson}`);
        const oldEntry = { ...originalEntry, json_path: actualJson, markdown_path: actualMarkdown };
        const staged = await stageConversationWrite({
          io: directoryIo(root),
          freshArchive: { ...archive, exporter_version: VERSION, classification },
          oldEntry,
          markdownText: buildMarkdown,
        });
        if (staged.kind !== "staged") throw new Error(`原 JSON 无法安全读取，已写入恢复区：${staged.recovery_path}`);
        index.conversations[staged.archive.conversation_id] = indexEntryFromArchive(staged.archive, staged.paths);
        await persistIndexes(root, index);
        staged.pending.stage = "index_written";
        await writeJson(root, staged.pending_path, staged.pending);
        const finalized = await recoverPendingCommit({
          io: directoryIo(root), pendingFile: staged.pending_path, record: staged.pending, index,
          renderMarkdown: buildMarkdown, persistIndex: (next) => persistIndexes(root, next),
        });
        if (!finalized.complete) throw new Error(`提交校验失败：${finalized.errors.join("；")}`);
        await removeVerifiedConversationDuplicates(root, staged.archive.conversation_id, staged.paths);
        migrated.push({
          conversation_id: staged.archive.conversation_id,
          title: staged.archive.title,
          json_path: staged.paths.json,
          markdown_path: staged.paths.markdown,
        });
      } catch (error) {
        failed.push(`${originalEntry.title}：${error.message || error}`);
      }
    }
    if (migrated.length) {
      const archives = await readIndexedArchives(root, index);
      if (!archives.issues.length) await writeJson(root, "timeline.json", timelineFromArchives(archives.archives));
      await refreshConversationStateFromIndex(root, index, migrated.map((item) => item.conversation_id));
    }
    return { migrated, failed };
  }

  async function reconcileRegisteredFolderMoves() {
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    const migrated = [];
    const failed = [];
    for (const [index, rule] of classificationRules.entries()) {
      setStatus(`正在整理本地位置 ${index + 1}/${classificationRules.length}\n${ruleTargetFolder(rule)}`, "normal", true);
      const result = await migrateLocalConversationsForRule(directory.handle, rule);
      migrated.push(...result.migrated);
      failed.push(...result.failed);
    }
    await refreshFolderDiscoveries({ interactive: false, announce: false });
    setStatus(
      `本地移动同步完成\n已成对迁移或补齐：${migrated.length} 个对话`
      + (failed.length ? `\n未能自动处理：${failed.length} 个\n${failed.slice(0, 8).join("\n")}` : "")
      + "\n没有规则的目录会作为可选建议显示，你可以登记，也可以忽略。",
      failed.length ? "warning" : "ok",
    );
  }

  async function listPendingCommits(root) {
    try {
      const directory = await getDirectory(root, `${META_DIR}/pending`, false);
      const records = [];
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== "file" || !name.endsWith(".json")) continue;
        try {
          records.push({ path: `${META_DIR}/pending/${name}`, record: JSON.parse(await (await handle.getFile()).text()) });
        } catch (error) {
          records.push({ path: `${META_DIR}/pending/${name}`, error: error.message });
        }
      }
      return records;
    } catch (error) {
      if (error?.name === "NotFoundError") return [];
      throw error;
    }
  }

  async function reconcilePendingCommits(root, index) {
    const pending = await listPendingCommits(root);
    const repaired = [];
    const unresolved = [];
    for (const item of pending) {
      if (item.error || !item.record?.conversation_id) {
        unresolved.push(`${item.path}: ${item.error || "pending 记录无效"}`);
        continue;
      }
      const record = item.record;
      const result = await recoverPendingCommit({
        io: directoryIo(root), pendingFile: item.path, record, index,
        renderMarkdown: buildMarkdown, persistIndex: (next) => persistIndexes(root, next),
      });
      if (result.complete) {
        repaired.push(record.conversation_id);
      } else {
        unresolved.push(`${record.conversation_id}: ${result.errors.join("；")}`);
      }
    }
    return { detected: pending.length, repaired, unresolved };
  }

  async function inspectEnvironment({ interactiveDirectory = false, directoryHandle = null } = {}) {
    const adapter = resolvePlatformAdapter();
    const session = await adapter.getSession();
    if (!session.ok) throw new Error(`当前登录或会话接口不可用${session.status ? `（HTTP ${session.status}）` : ""}`);
    const inventory = await adapter.fetchInventory(session.token);
    const directory = directoryHandle
      ? { handle: directoryHandle, reason: "" }
      : await getAuthorizedDirectory(interactiveDirectory);
    let index = emptyIndex();
    let indexState = directory.reason;
    let indexIssues = [];
    let pendingState = { detected: 0, repaired: [], unresolved: [] };
    let indexUsable = false;
    if (directory.handle) {
      try {
        const loaded = await ensureIndex(directory.handle);
        index = loaded.index;
        indexIssues = loaded.issues || [];
        indexState = loaded.rebuilt ? "索引不存在，已从本地 JSON 重建" : "索引可读";
        pendingState = await reconcilePendingCommits(directory.handle, index);
        indexUsable = loaded.persisted !== false && pendingState.unresolved.length === 0;
        if (pendingState.repaired.length) indexState += `；已修复 ${pendingState.repaired.length} 个未完成提交`;
        if (pendingState.unresolved.length) indexState += `；仍有 ${pendingState.unresolved.length} 个未完成提交`;
      } catch (error) {
        indexState = `索引读取/重建失败：${error.message}`;
        indexUsable = false;
      }
    }
    let deletedState = emptyDeletedConversations();
    if (directory.handle) {
      try { deletedState = await loadDeletedConversations(directory.handle); } catch { /* handled by sync safety elsewhere */ }
    }
    const deletedIds = new Set(Object.keys(deletedState.deleted || {}));
    const remoteItems = (inventory.items || []).filter((item) => !deletedIds.has(String(item.id || item.conversation_id || "")));
    const plan = computeSyncPlan(remoteItems, index.conversations, Date.now(), classificationRules, classificationOverrides);
    const paginationComplete = (inventory.normal.total === null || inventory.normal.items.length === inventory.normal.total)
      && inventory.archived.paginationComplete !== false;
    const canSync = computeCanSync({
      directoryPermission: Boolean(directory.handle), sessionOk: session.ok, interfaceOk: true,
      paginationComplete, indexUsable, rebuildOk: indexUsable, indexPersisted: indexUsable,
    });
    return { adapter, session, inventory, directory, index, indexState, indexIssues, indexUsable, pendingState, paginationComplete, canSync, plan };
  }

  async function runHealthCheck() {
    setStatus("正在检查登录、目录分页、授权和本地索引……");
    const supported = typeof window.showDirectoryPicker === "function";
    let environment;
    try {
      const authorized = await getAuthorizedDirectory(false);
      if (authorized.handle) await readSharedClassificationRules(authorized.handle);
      environment = await inspectEnvironment({
        interactiveDirectory: false,
        directoryHandle: authorized.handle || null,
      });
    } catch (error) {
      setStatus(`健康检查失败\n${error.message}\nFile System Access API：${supported ? "支持" : "不支持，无法执行本地同步"}`, "error");
      return;
    }
    const currentId = environment.adapter.getConversationId(location);
    const lines = [
      "健康检查", `平台适配器：${environment.adapter.displayName}（${environment.adapter.id}）`, `登录/接口：正常`, `当前页面对话 ID：${currentId || "未处于具体对话页（不影响全量同步）"}`,
      `普通目录：${environment.inventory.normal.items.length}/${environment.inventory.normal.total ?? "total 未提供"}`,
      environment.inventory.archived.supported
        ? `归档目录：${environment.inventory.archived.items.length}/${environment.inventory.archived.total ?? "total 未提供"}`
        : `归档目录：不可用（${environment.inventory.archivedBoundary}）`,
      `目录授权：${environment.directory.handle ? "有效" : environment.directory.reason}`,
      `本地索引：${environment.indexState}`, planSummary(environment.plan),
    ];
    if (environment.directory.handle) {
      const audit = await auditExportFolders(environment.directory.handle);
      ui._folderAudit = audit;
      renderFolderDiscoveries(audit);
      lines.push(audit.hasDrift ? `目录与规则审计：发现 ${folderAuditLines(audit).length} 项待处理` : "目录与规则审计：一致");
      if (audit.hasDrift) lines.push(...folderAuditLines(audit).slice(0, 12));
    }
    if (!supported) lines.push("阻断：当前浏览器没有 showDirectoryPicker()，不能伪装为可同步。");
    if (environment.indexIssues.length) lines.push(`索引重建问题：${environment.indexIssues.length} 个`);
    if (!environment.indexUsable) lines.push("阻断：本地索引不可用，禁止同步写入。");
    if (!environment.paginationComplete) lines.push("阻断：对话目录分页不完整。");
    setStatus(lines.join("\n"), environment.canSync ? (environment.inventory.archived.supported ? "ok" : "warning") : "error");
  }

  async function runSync() {
    cancelRequested = false;
    const startedAt = new Date().toISOString();
    setStatus("正在准备导出；首次使用会请求选择导出目录……");
    // 目录选择必须紧邻用户点击，不能排在目录/网络扫描之后。
    const authorized = await getAuthorizedDirectory(true);
    const root = authorized.handle;
    if (!root) throw new Error(authorized.reason || "未获得导出目录");
    await ensureArchiveStructure(root);
    await readSharedClassificationRules(root);
    setStatus("正在检查本地文件有没有移动或删除……", "normal", true);
    let localAudit = await auditExportFolders(root);
    if (localAudit.stateChangeResult?.trusted === false && Object.keys(localAudit.conversationState?.conversations || {}).length) {
      ui._folderAudit = localAudit;
      renderFolderDiscoveries(localAudit);
      setStatus(`导出已暂停\n本地目录没有完整扫描，为避免误删或覆盖，暂不继续。`, "warning");
      return;
    }
    const settledLocal = await settleDetectedLocalChanges(root, localAudit, { statusPrefix: "导出前先处理本地变化" });
    localAudit = settledLocal.audit;
    ui._folderAudit = localAudit;
    renderFolderDiscoveries(localAudit);
    const unresolvedLocal = (localAudit.conversationChanges || []).filter((item) => ["conflict", "uncertain"].includes(item.type));
    const blockingLocalCount = unresolvedLocal.length + (localAudit.missingFileIssues?.length || 0) + (localAudit.conversationIssues?.length || 0);
    const remainingFolderChanges = localAudit.folderChanges?.length || 0;
    if (blockingLocalCount || remainingFolderChanges || settledLocal.failures.length) {
      const detail = [
        blockingLocalCount ? `${blockingLocalCount} 个对话需要确认` : "",
        remainingFolderChanges ? `${remainingFolderChanges} 个目录还没对齐` : "",
        settledLocal.failures.length ? `${settledLocal.failures.length} 项自动处理失败` : "",
      ].filter(Boolean).join("，");
      setStatus(`导出已暂停\n${detail}。到“管理”里处理后再导出。`, "warning");
      if (typeof setMainView === "function") setMainView("manage");
      return;
    }
    const environment = await inspectEnvironment({ directoryHandle: root });
    if (!environment.canSync) {
      setStatus(`导出失败\n准备阶段没有通过：${environment.indexState}`, "error");
      return;
    }
    const plan = environment.plan;
    setStatus(`导出前统计\n${planSummary(plan)}\n需要读取正文 ${plan.queue.length} 个对话`, "normal", true);
    await sleep(50);

    const index = environment.index;
    const warnings = [...environment.indexIssues];
    let added = 0;
    let updated = 0;
    let preserved = 0;
    const changedConversations = [];
    const makeResult = (snapshot) => ({
      startedAt, finishedAt: new Date().toISOString(), summary: planSummary(plan), added, updated,
      skipped: plan.skip.length + Math.max(0, plan.queue.length - snapshot.written - snapshot.failures.length - snapshot.recoveries.length),
      failed: snapshot.failures, warnings: Array.from(new Set(warnings)), preserved, written: snapshot.written,
      archivedBoundary: environment.inventory.archivedBoundary, cancelled: snapshot.cancelled,
      recoveries: snapshot.recoveries, stageFailures: snapshot.stageFailures,
    });
    const outcome = await executeSyncWorkflow({
      items: plan.queue,
      shouldCancel: () => cancelRequested,
      onProgress: (position, total, item) => setStatus(`导出中 ${position}/${total}\n${item.title}\n${planSummary(plan)}`, "normal", true),
      processItem: async (item) => {
        const remote = await environment.adapter.fetchConversation(item.id, environment.session.token);
        const fresh = buildArchive(remote.data, item, classificationRules, classificationOverrides);
        const oldEntry = index.conversations[item.id];
        const staged = await stageConversationWrite({
          io: directoryIo(root), freshArchive: fresh, oldEntry,
          markdownText: buildMarkdown,
        });
        if (staged.kind === "recovery") {
          warnings.push(`${item.id} 原 JSON 损坏，已写入旁路恢复文件且未覆盖原文件`);
          return staged;
        }
        if (staged.preserved) {
          preserved++;
          warnings.push(`${item.id} 新数据节点较少，已合并并保留本地历史节点`);
        }
        if (oldEntry) staged.wasUpdate = true;
        else staged.wasAdd = true;
        const { archive } = staged;
        if (archive.conversion_warnings.length) warnings.push(...archive.conversion_warnings.map((x) => `${item.id}: ${x}`));
        await sleep(120);
        return staged;
      },
      applyIndex: (staged) => {
        index.conversations[staged.archive.conversation_id] = indexEntryFromArchive(staged.archive, staged.paths);
        changedConversations.push({
          conversation_id: staged.archive.conversation_id,
          title: staged.archive.title,
          update_time: staged.archive.update_time,
          export_revision: staged.archive.export_revision,
          message_count: staged.archive.messages?.length || 0,
          markdown_path: staged.paths.markdown,
          json_path: staged.paths.json,
          classification: staged.archive.classification,
          relocated_from: staged.relocated_from,
          merge_mode: staged.archive.merge_mode || "new-archive",
          needs_ai_review: true,
        });
        if (staged.wasUpdate) updated++; else added++;
      },
      persistIndex: () => persistIndexes(root, index),
      finalizeCommit: async (staged) => {
        staged.pending.stage = "index_written";
        await writeJson(root, staged.pending_path, staged.pending);
        const finalized = await recoverPendingCommit({
          io: directoryIo(root), pendingFile: staged.pending_path, record: staged.pending, index,
          renderMarkdown: buildMarkdown, persistIndex: (next) => persistIndexes(root, next),
        });
        if (!finalized.complete) throw new Error(`${staged.archive.conversation_id} 提交校验失败：${finalized.errors.join("；")}`);
        if (staged.relocated_from) {
          for (const oldPath of [staged.relocated_from.json, staged.relocated_from.markdown]) {
            if (!oldPath || oldPath === staged.paths.json || oldPath === staged.paths.markdown) continue;
            try {
              await removeFile(root, oldPath);
              await removeEmptyAncestorDirectories(root, oldPath);
            } catch (error) {
              warnings.push(`${staged.archive.conversation_id} 已写入新分类，但旧文件或空目录清理失败：${oldPath}（${error.message}）`);
            }
          }
        }
      },
      writeTimeline: async () => {
        const archiveResult = await readIndexedArchives(root, index);
        warnings.push(...archiveResult.issues);
        if (archiveResult.issues.length) {
          throw new Error(`有 ${archiveResult.issues.length} 个索引档案不可读，已保留旧 timeline`);
        }
        await writeJson(root, "timeline.json", timelineFromArchives(archiveResult.archives));
      },
      writeHistory: async (snapshot) => {
        const result = makeResult(snapshot);
        const report = buildReport(result);
        await appendHistory(root, {
          started_at: startedAt, finished_at: result.finishedAt, status: report.status,
          added, updated, skipped: result.skipped, failed: result.failed.length, preserved,
        });
      },
      writeReport: async (snapshot) => writeText(root, `${META_DIR}/last-report.md`, buildReport(makeResult(snapshot)).markdown),
    });
    if (!outcome.stageFailures.some((item) => item.stage === "conversation-index")) {
      try { await refreshConversationStateFromIndex(root, index); }
      catch (error) { outcome.stageFailures.push({ stage: "conversation-state", reason: error.message || String(error) }); }
    }
    try {
      await writeJson(root, CHANGE_MANIFEST_PATH, {
        schema_version: "1.0",
        exporter_version: VERSION,
        generated_at: new Date().toISOString(),
        sync_started_at: startedAt,
        changes: changedConversations,
      });
    } catch (error) {
      outcome.stageFailures.push({ stage: "conversation-changes", reason: error.message || String(error) });
    }
    const result = makeResult(outcome);
    const details = outcome.failures.length ? `\n${outcome.failures.map((x) => `${x.id}: ${x.reason}`).join("\n")}` : "";
    const stageDetails = outcome.stageFailures.length ? `\n${outcome.stageFailures.map((x) => `${x.stage}: ${x.reason}`).join("\n")}` : "";
    ui._folderAudit = await auditExportFolders(root);
    renderFolderDiscoveries(ui._folderAudit);
    const outcomeLabel = outcome.state === "完整同步" ? "导出完成" : outcome.state === "部分同步" ? "导出完成，但有部分问题" : "导出失败";
    setStatus(`${outcomeLabel}\n新增 ${added}｜更新 ${updated}｜未变化 ${result.skipped}｜失败 ${outcome.failures.length}${details}${stageDetails}`, outcome.state === "完整同步" ? "ok" : outcome.state === "部分同步" ? "warning" : "error");
  }


  function extractionOptionsFromUi() {
    const timeValue = ui?.extractTime?.value || "all";
    return normalizeExtractionOptions({
      days: timeValue === "7" ? 7 : timeValue === "30" ? 30 : 0,
      start: timeValue === "custom" ? ui.extractStart?.value : "",
      end: timeValue === "custom" ? ui.extractEnd?.value : "",
      field: ui?.extractField?.value || "",
      folder: ui?.extractFolder?.value || "",
      include_subfolders: ui?.extractIncludeSubfolders?.checked !== false,
      keyword: ui?.extractKeyword?.value || "",
    });
  }

  function extractionTimeLabel() {
    const value = ui?.extractTime?.value || "all";
    if (value === "7") return "最近7天";
    if (value === "30") return "最近30天";
    if (value === "custom") return `${ui.extractStart?.value || "起始"}_到_${ui.extractEnd?.value || "现在"}`;
    return "全部时间";
  }

  function populateExtractionFilters(index) {
    if (!ui?.extractField || !ui?.extractFolder) return;
    const entries = Object.values(index?.conversations || {});
    const currentField = ui.extractField.value;
    const currentFolder = ui.extractFolder.value;
    const fields = [...new Set(entries.map(extractionFieldFromEntry).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const folders = [...new Set(entries.map(extractionFolderFromEntry).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    ui.extractField.innerHTML = '<option value="">全部命名</option>' + fields.map((field) => `<option value="${escapeHtml(field)}">${escapeHtml(field)}</option>`).join("");
    ui.extractFolder.innerHTML = '<option value="">全部文件夹</option>' + folders.map((folder) => `<option value="${escapeHtml(folder)}">${escapeHtml(folder)}</option>`).join("");
    if (fields.includes(currentField)) ui.extractField.value = currentField;
    if (folders.includes(currentFolder)) ui.extractFolder.value = currentFolder;
  }

  function renderExtractionCandidates(entries) {
    if (!ui?.extractResults || !ui?.extractList || !ui?.extractSummary) return;
    ui._extractCandidates = entries;
    ui.extractResults.hidden = false;
    ui.extractSummary.textContent = `找到 ${entries.length} 个对话`;
    if (!entries.length) {
      ui.extractList.innerHTML = '<div class="empty">没有找到符合条件的对话。</div>';
      return;
    }
    const visible = entries.slice(0, 500);
    ui.extractList.innerHTML = visible.map((entry) => {
      const time = entry.update_time ? String(entry.update_time).slice(0, 10) : "时间未知";
      const field = extractionFieldFromEntry(entry);
      const folder = extractionFolderFromEntry(entry) || "未归类";
      return `<label class="extract-row"><input type="checkbox" data-role="extract-select" value="${escapeHtml(entry.conversation_id)}" checked /><span><strong>${escapeHtml(entry.title || "未命名对话")}</strong><small>${escapeHtml([time, field, folder].filter(Boolean).join(" · "))}</small></span></label>`;
    }).join("") + (entries.length > visible.length ? `<div class="hint">列表只展示前 ${visible.length} 个；请缩小筛选范围后再打包。</div>` : "");
  }

  async function prepareExtractionCatalog({ interactive = false } = {}) {
    const directory = await getAuthorizedDirectory(interactive);
    if (!directory.handle) return null;
    await ensureArchiveStructure(directory.handle);
    await readSharedClassificationRules(directory.handle);
    const index = await ensureIndex(directory.handle).then((result) => result.index);
    ui._extractIndex = index;
    populateExtractionFilters(index);
    return index;
  }

  async function previewExtraction() {
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    const index = await ensureIndex(directory.handle).then((result) => result.index);
    ui._extractIndex = index;
    populateExtractionFilters(index);
    const entries = filterExtractionEntries(index, extractionOptionsFromUi());
    renderExtractionCandidates(entries);
    const formats = [ui.extractJson?.checked ? "JSON" : "", ui.extractMarkdown?.checked ? "Markdown" : ""].filter(Boolean).join(" + ");
    ui._extractDirty = false;
    setStatus(`找到 ${entries.length} 个对话${formats ? `｜${formats}` : ""}`, entries.length ? "ok" : "warning");
    return entries;
  }


  function packageBaseNameForExtraction(options, entries) {
    const scope = options.field || options.folder?.split("/").filter(Boolean).at(-1) || (options.keyword ? `搜索_${options.keyword}` : "对话");
    return `${cleanSegment(scope, "对话")}_${cleanSegment(extractionTimeLabel(), "提取")}_${entries.length}个`;
  }

  function extractionPackageName(options, entries) {
    const manual = String(ui?.extractPackageName?.value || "").trim();
    if (!manual) return packageBaseNameForExtraction(options, entries);
    const error = validatePathPart(manual, "本次提取名称");
    if (error) throw new Error(error);
    return cleanSegment(manual, "本次提取");
  }

  function localExtractionStamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  function loadExtractionEntryState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(EXTRACT_ENTRY_STATE_KEY) || "null");
      const items = Array.isArray(parsed?.items) ? parsed.items
        .map((item) => ({ name: String(item?.name || "").trim(), kind: item?.kind === "directory" ? "directory" : "file" }))
        .filter((item) => item.name && !item.name.includes("/") && !item.name.includes("\\")) : [];
      return { items, updated_at: parsed?.updated_at || null, package_name: parsed?.package_name || null, kind: parsed?.kind || null };
    } catch { return { items: [], updated_at: null, package_name: null, kind: null }; }
  }

  function saveExtractionEntryState(state) {
    const normalized = {
      items: Array.isArray(state?.items) ? state.items.map((item) => ({ name: String(item.name || ""), kind: item.kind === "directory" ? "directory" : "file" })).filter((item) => item.name) : [],
      updated_at: state?.updated_at || new Date().toISOString(),
      package_name: state?.package_name || null,
      kind: state?.kind || null,
    };
    localStorage.setItem(EXTRACT_ENTRY_STATE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  async function extractionEntryTopLevel(handle) {
    const result = [];
    for await (const [name, entry] of handle.entries()) result.push({ name, kind: entry.kind });
    return result.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  async function sameDirectoryHandle(a, b) {
    if (!a || !b) return false;
    if (typeof a.isSameEntry !== "function") return a === b;
    try { return await a.isSameEntry(b); } catch { return false; }
  }

  async function chooseExtractionEntryDirectory() {
    if (typeof window.showDirectoryPicker !== "function") throw new Error("当前浏览器不能选择本地文件夹");
    const previous = ui?._extractEntryHandle || null;
    const options = { mode: "readwrite", id: "chatgpt-local-extract-entry" };
    if (previous) options.startIn = previous;
    else options.startIn = "desktop";
    let handle;
    try { handle = await window.showDirectoryPicker(options); }
    catch (error) {
      if (error?.name === "TypeError") handle = await window.showDirectoryPicker({ mode: "readwrite", id: "chatgpt-local-extract-entry" });
      else throw error;
    }
    if (!(await verifyPermission(handle, true))) throw new Error("没有获得快捷入口的读写权限");
    const same = await sameDirectoryHandle(previous, handle);
    if (!same) {
      const existing = await extractionEntryTopLevel(handle);
      if (existing.length) throw new Error("快捷入口需要是一个空文件夹。请新建一个空文件夹（例如桌面的“AI提取入口”）再选择，避免覆盖你自己的文件。");
      saveExtractionEntryState({ items: [], package_name: null, kind: null });
    }
    await idbSetStoredHandle(IDB_EXTRACT_ENTRY_KEY, handle);
    ui._extractEntryHandle = handle;
    updateExtractionOutputDisplay();
    setStatus(`快捷入口已设置：${handle.name || "已选择的文件夹"}\n以后每次提取都会把最新结果放到这里。`, "ok");
    return handle;
  }

  async function resolveExtractionEntry() {
    const handle = ui?._extractEntryHandle || await idbGetStoredHandle(IDB_EXTRACT_ENTRY_KEY);
    if (!handle || !(await verifyPermission(handle, false))) return null;
    ui._extractEntryHandle = handle;
    updateExtractionOutputDisplay();
    return handle;
  }

  function updateExtractionOutputDisplay() {
    if (ui?.extractEntryLocation) {
      const handle = ui._extractEntryHandle;
      ui.extractEntryLocation.textContent = handle
        ? `快捷入口：${handle.name || "已选择的文件夹"}`
        : "快捷入口：还没设置（建议选桌面上的空文件夹）";
    }
    if (ui?.extractHistoryLocation) {
      const libraryName = cachedDirectoryHandle?.name || "当前资料库";
      ui.extractHistoryLocation.textContent = `历史记录：${libraryName} / ${EXTRACTION_HISTORY_FOLDER}`;
    }
  }

  async function validateExtractionEntryForUse(handle) {
    const existing = await extractionEntryTopLevel(handle);
    const state = loadExtractionEntryState();
    const known = new Set(state.items.map((item) => item.name));
    const extras = existing.filter((item) => !known.has(item.name));
    if (extras.length) {
      throw new Error(`快捷入口里有不是上一次提取留下的内容：${extras.slice(0, 5).map((item) => item.name).join("、")}${extras.length > 5 ? "……" : ""}。为了避免误删，请移走这些内容，或换一个空文件夹。`);
    }
    return state;
  }

  async function clearPreviousExtractionEntry(handle) {
    const state = await validateExtractionEntryForUse(handle);
    for (const item of state.items) {
      try { await handle.removeEntry(item.name, { recursive: item.kind === "directory" }); }
      catch (error) { if (error?.name !== "NotFoundError") throw error; }
    }
    saveExtractionEntryState({ items: [], package_name: null, kind: null });
  }

  async function fileExists(root, path) {
    try { await getFileHandle(root, path, false); return true; }
    catch (error) { if (error?.name === "NotFoundError") return false; throw error; }
  }

  async function folderExists(root, path) {
    try { await getDirectory(root, path, false); return true; }
    catch (error) { if (error?.name === "NotFoundError") return false; throw error; }
  }

  async function uniqueExtractionPath(root, basePath, baseName, kind) {
    for (let index = 1; index <= 999; index++) {
      const suffix = index === 1 ? "" : `_${index}`;
      const name = kind === "zip" ? `${baseName}${suffix}.zip` : `${baseName}${suffix}`;
      const path = joinPath(basePath, name);
      const exists = kind === "zip" ? await fileExists(root, path) : await folderExists(root, path);
      if (!exists) return path;
    }
    throw new Error("同名提取记录太多，请换一个名称");
  }

  function uniqueFlatExtractionName(name, usedNames = new Set()) {
    const original = String(name || "file").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "file";
    if (!usedNames.has(original)) {
      usedNames.add(original);
      return original;
    }
    const match = original.match(/^(.*?)(\.[^.]*)?$/);
    const stem = match?.[1] || original;
    const ext = match?.[2] || "";
    for (let index = 2; index <= 9999; index++) {
      const candidate = `${stem}__${index}${ext}`;
      if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
      }
    }
    throw new Error(`快捷入口里同名文件太多：${original}`);
  }

  async function collectDirectoryFilesFlat(sourceDirectory, prefix = "", output = []) {
    for await (const [name, handle] of sourceDirectory.entries()) {
      const relativePath = joinPath(prefix, name);
      if (handle.kind === "directory") await collectDirectoryFilesFlat(handle, relativePath, output);
      // 旧版本的提取历史可能带 package-manifest.json；快捷入口永远不复制这种工程文件。
      else if (name !== "package-manifest.json") output.push({ relative_path: relativePath, source_name: name, handle });
    }
    return output;
  }

  async function copyDirectoryContentsFlat(sourceDirectory, destinationRoot) {
    const files = await collectDirectoryFilesFlat(sourceDirectory);
    files.sort((a, b) => a.relative_path.localeCompare(b.relative_path, "zh-CN"));
    const usedNames = new Set();
    const created = [];
    try {
      for (const item of files) {
        const destinationName = uniqueFlatExtractionName(item.source_name, usedNames);
        const bytes = new Uint8Array(await (await item.handle.getFile()).arrayBuffer());
        await writeBinary(destinationRoot, destinationName, bytes);
        created.push({ name: destinationName, kind: "file", source_path: item.relative_path });
      }
      return created;
    } catch (error) {
      error.extractionCreatedItems = created;
      throw error;
    }
  }

  async function syncHistoryToExtractionEntry({ historyRoot, historyPath, kind, baseName, entryHandle }) {
    await validateExtractionEntryForUse(entryHandle);
    await clearPreviousExtractionEntry(entryHandle);
    if (kind === "zip") {
      const entryName = `${baseName}.zip`;
      const sourceFile = await getFileHandle(historyRoot, historyPath, false);
      const bytes = new Uint8Array(await (await sourceFile.getFile()).arrayBuffer());
      try {
        await writeBinary(entryHandle, entryName, bytes);
        saveExtractionEntryState({ items: [{ name: entryName, kind: "file" }], package_name: baseName, kind });
      } catch (error) {
        // 即使写入中断，也把可能创建出的文件记下来，下一次可以安全清理。
        saveExtractionEntryState({ items: [{ name: entryName, kind: "file" }], package_name: baseName, kind });
        throw error;
      }
      return { items: [{ name: entryName, kind: "file" }], display: `${entryHandle.name || "快捷入口"} / ${entryName}` };
    }
    const sourceDirectory = await getDirectory(historyRoot, historyPath, false);
    try {
      const flatItems = await copyDirectoryContentsFlat(sourceDirectory, entryHandle);
      const stateItems = flatItems.map((item) => ({ name: item.name, kind: "file" }));
      saveExtractionEntryState({ items: stateItems, package_name: baseName, kind });
      return { items: stateItems, display: `${entryHandle.name || "快捷入口"}（文件已直接平铺）` };
    } catch (error) {
      const partial = Array.isArray(error?.extractionCreatedItems) ? error.extractionCreatedItems : [];
      saveExtractionEntryState({ items: partial.map((item) => ({ name: item.name, kind: "file" })), package_name: baseName, kind });
      throw error;
    }
  }

  function selectedExtractionEntries() {
    const selected = new Set([...(ui?.extractList?.querySelectorAll('[data-role="extract-select"]:checked') || [])].map((input) => input.value));
    return (ui?._extractCandidates || []).filter((entry) => selected.has(String(entry.conversation_id)));
  }

  function invalidateExtractionPreview() {
    if (!ui) return;
    ui._extractCandidates = null;
    ui._extractDirty = true;
    if (ui.extractPreviewButton) ui.extractPreviewButton.textContent = "查看筛选结果";
  }

  async function toggleExtractionPreview() {
    if (!ui?.extractResults || !ui?.extractPreviewButton) return [];
    const entries = await previewExtraction();
    ui.extractResults.hidden = false;
    ui.extractPreviewButton.textContent = "重新查看结果";
    ui._extractDirty = false;
    setExtractScene("results", 1);
    return entries;
  }

  function renderExtractionComplete(result) {
    if (!ui?.extractComplete || !ui?.extractCompleteText) return;
    ui.extractComplete.hidden = false;
    const kindLabel = result.kind === "folder" ? "普通文件" : "ZIP 压缩包";
    const lines = [
      `已准备好 ${result.conversationCount} 个对话（${kindLabel}）`,
      result.entryError ? `快捷入口更新失败：${result.entryError}` : `快捷入口已更新：${result.entryDisplay}`,
      `历史已保存：${result.historyDisplay}`,
    ];
    ui.extractCompleteText.textContent = lines.join("\n");
    if (ui.extractDeleteHistoryButton) {
      ui.extractDeleteHistoryButton.disabled = !result.historyPath;
      ui.extractDeleteHistoryButton.textContent = result.historyPath ? "删除这次历史记录" : "历史记录已删除";
    }
    setExtractScene("complete", 1);
  }

  async function generateExtractionPackage() {
    if (ui?._extractDirty || !ui?._extractCandidates) await previewExtraction();
    const entries = selectedExtractionEntries();
    if (!entries.length) throw new Error("请先筛选并选择至少一个对话");
    if (entries.length > 500) throw new Error("一次最多提取 500 个对话，请缩小范围");
    const includeJson = Boolean(ui.extractJson?.checked);
    const includeMarkdown = Boolean(ui.extractMarkdown?.checked);
    if (!includeJson && !includeMarkdown) throw new Error("请至少选择 JSON 或 Markdown 一种内容");

    const archiveDirectory = await getAuthorizedDirectory(true);
    if (!archiveDirectory.handle) throw new Error(archiveDirectory.reason);
    await ensureArchiveStructure(archiveDirectory.handle);
    const entryHandle = await resolveExtractionEntry();
    if (!entryHandle) throw new Error("请先点“选择 / 更换快捷入口”，选一个空文件夹。以后只需要设置一次。");
    await validateExtractionEntryForUse(entryHandle);

    const options = extractionOptionsFromUi();
    const kind = ui.extractOutputKind?.value === "folder" ? "folder" : "zip";
    const baseName = extractionPackageName(options, entries);
    const historyName = `${localExtractionStamp()}_${baseName}`;
    const historyPath = await uniqueExtractionPath(archiveDirectory.handle, EXTRACTION_HISTORY_FOLDER, historyName, kind);
    const manifestItems = [];
    const zipEntries = [];

    for (const entry of entries) {
      if (includeJson) await getFileHandle(archiveDirectory.handle, entry.json_path, false)
        .catch((error) => { throw new Error(`${entry.title} 的 JSON 不存在或无法读取：${entry.json_path}（${error.message || error}）`); });
      if (includeMarkdown) await getFileHandle(archiveDirectory.handle, entry.markdown_path, false)
        .catch((error) => { throw new Error(`${entry.title} 的 Markdown 不存在或无法读取：${entry.markdown_path}（${error.message || error}）`); });
    }

    if (kind === "folder") await getDirectory(archiveDirectory.handle, historyPath, true);

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      setStatus(`正在提取 ${index + 1}/${entries.length}\n${entry.title}`, "normal", true);
      const item = {
        conversation_id: entry.conversation_id,
        title: entry.title,
        create_time: entry.create_time || null,
        update_time: entry.update_time || null,
        classification: entry.classification || null,
        json_path: includeJson ? entry.json_path : null,
        markdown_path: includeMarkdown ? entry.markdown_path : null,
      };
      if (includeJson) {
        const content = await readText(archiveDirectory.handle, entry.json_path);
        if (content === null) throw new Error(`${entry.title} 的 JSON 不存在：${entry.json_path}`);
        if (kind === "zip") zipEntries.push({ name: normalizeStatePath(entry.json_path), data: utf8Bytes(content) });
        else await writeText(archiveDirectory.handle, joinPath(historyPath, normalizeStatePath(entry.json_path)), content);
      }
      if (includeMarkdown) {
        const content = await readText(archiveDirectory.handle, entry.markdown_path);
        if (content === null) throw new Error(`${entry.title} 的 Markdown 不存在：${entry.markdown_path}`);
        if (kind === "zip") zipEntries.push({ name: normalizeStatePath(entry.markdown_path), data: utf8Bytes(content) });
        else await writeText(archiveDirectory.handle, joinPath(historyPath, normalizeStatePath(entry.markdown_path)), content);
      }
      manifestItems.push(item);
    }

    const manifest = {
      schema_version: "1.1",
      tool_version: VERSION,
      generated_at: new Date().toISOString(),
      package_name: baseName,
      filter: { ...options, time_label: extractionTimeLabel() },
      formats: { json: includeJson, markdown: includeMarkdown },
      output: kind,
      delivery: "quick-entry-plus-history",
      conversation_count: manifestItems.length,
      conversations: manifestItems,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    // 用户拿来拖拽/上传的提取结果只放真正选中的对话文件，不再夹带工程清单。
    // 如果以后需要追溯这次提取的筛选条件，清单只留在插件自己的隐藏元数据目录。
    if (kind === "zip") await writeBinary(archiveDirectory.handle, historyPath, createStoreZip(zipEntries));
    const extractionMetaPath = joinPath(EXTRACTION_HISTORY_META_DIR, `${historyName}.json`);
    await writeText(archiveDirectory.handle, extractionMetaPath, manifestText);

    const historyDisplay = `${archiveDirectory.handle.name || "当前资料库"} / ${historyPath}`;
    const result = {
      historyRoot: archiveDirectory.handle,
      historyPath,
      metaPath: extractionMetaPath,
      kind,
      baseName,
      historyDisplay,
      entryDisplay: entryHandle.name || "快捷入口",
      entryError: null,
      conversationCount: entries.length,
    };
    try {
      const entryResult = await syncHistoryToExtractionEntry({
        historyRoot: archiveDirectory.handle, historyPath, kind, baseName, entryHandle,
      });
      result.entryDisplay = entryResult.display;
    } catch (error) {
      result.entryError = error?.message || String(error);
    }
    ui._lastExtraction = result;
    renderExtractionComplete(result);
    setStatus(
      result.entryError
        ? `提取历史已经保存，但快捷入口没更新成功。\n${result.entryError}\n历史：${historyDisplay}`
        : `提取完成\n${entries.length} 个对话\n快捷入口已经换成这一次的内容。\n历史：${historyDisplay}`,
      result.entryError ? "warning" : "ok",
    );
    return result;
  }

  async function deleteLastExtraction() {
    const last = ui?._lastExtraction;
    if (!last?.historyRoot || !last.historyPath) throw new Error("还没有可以删除的本次历史记录");
    if (!(await verifyPermission(last.historyRoot, true))) throw new Error("资料库需要重新授权");
    const parts = normalizeStatePath(last.historyPath).split("/").filter(Boolean);
    const name = parts.pop();
    const parent = await getDirectory(last.historyRoot, parts.join("/"), false);
    if (!window.confirm(`删除这次提取历史？\n${last.historyDisplay}\n\n只删除资料库里的这条历史记录。快捷入口和原始对话都不会删除。`)) return;
    await parent.removeEntry(name, { recursive: last.kind === "folder" });
    if (last.metaPath) {
      try { await removeFile(last.historyRoot, last.metaPath); } catch (error) { if (error?.name !== "NotFoundError") console.warn("提取历史元数据清理失败", error); }
    }
    ui._lastExtraction.historyPath = null;
    ui._lastExtraction.metaPath = null;
    ui._lastExtraction.historyDisplay = "这次历史记录已删除";
    renderExtractionComplete(ui._lastExtraction);
    setStatus("这次提取历史已删除；快捷入口和原始对话都没有变化。", "ok");
  }

  function resetExtractionComplete() {
    ui._lastExtraction = null;
    setExtractScene("filter", -1);
    setStatus("可以继续选下一批对话。", "normal");
  }

  async function runRebuild() {
    cancelRequested = false;
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    const result = await rebuildIndex(directory.handle, (text) => setStatus(text, "normal", true));
    const archives = await readIndexedArchives(directory.handle, result.index);
    await writeJson(directory.handle, "timeline.json", timelineFromArchives(archives.archives));
    await refreshConversationStateFromIndex(directory.handle, result.index);
    setStatus(`本地档案已重新读取\n识别对话 ${Object.keys(result.index.conversations).length} 个\n损坏、未知或非插件 JSON ${result.issues.length} 个${result.issues.length ? `\n${result.issues.slice(0, 12).join("\n")}` : ""}`, result.issues.length ? "warning" : "ok");
  }

  async function runAction(action) {
    if (running && action !== "cancel") return;
    if (action === "cancel") {
      cancelRequested = true;
      setStatus("正在取消；当前文件操作结束后停止……", "warning", true);
      return;
    }
    running = true;
    updateBusy();
    try {
      if (action === "view-export") setMainView("export");
      else if (action === "view-manage") { setMainView("manage"); await refreshRuleFolderChoices({ interactive:false }); updateManageHomeSummary(ui?._folderAudit); }
      else if (action === "view-extract") { setMainView("extract"); updateExtractionOutputDisplay(); await prepareExtractionCatalog({ interactive:false }); }
      else if (action === "manage-home") setManageScene("home",-1);
      else if (action === "manage-rules") { renderClassificationRules(); setManageScene("rules",1); }
      else if (action === "manage-ignored") {
        if (cachedDirectoryHandle) await refreshFolderDiscoveries({ interactive:false,announce:false,autoApply:false });
        renderIgnoredItems();
        setManageScene("ignored",1);
      }
      else if (action === "manage-organizer") { renderConversationIssues(ui?._folderAudit); setManageScene("organizer",1); }
      else if (action === "rules-new") { resetRuleForm(); ui._ruleReturnScene = "rules"; if (ui.ruleBackButton) ui.ruleBackButton.textContent = "‹ 分类规则"; setManageScene("rule-editor",1,{focus:ui.ruleField}); }
      else if (action === "rules-back") cancelRuleEditor();
      else if (action === "rule-delete-current") {
        if (!ui?._editingRuleId) cancelRuleEditor();
        else { await deleteClassificationRule(ui._editingRuleId); renderClassificationRules(); setManageScene("rules",-1); }
      }
      else if (action === "health") await runHealthCheck();
      else if (action === "sync") await runSync();
      else if (action === "folder-scan") { const audit = await refreshFolderDiscoveries({ interactive:true,announce:true,autoApply:true }); if (audit) routeManageAfterAudit(audit); }
      else if (action === "state-apply") { await applyDetectedConversationChange(ui?._pendingConversationId); routeManageAfterAudit(ui?._folderAudit); }
      else if (action === "issue-delete") { await confirmMissingIssueDeleted(ui?._pendingConversationId); routeManageAfterAudit(ui?._folderAudit); }
      else if (action === "state-apply-all") { await applyAllDetectedConversationChanges(); routeManageAfterAudit(ui?._folderAudit); }
      else if (action === "remote-title-scan") { await scanRemoteTitleRules(); setManageScene("rules",1); }
      else if (action === "remote-rule-prefill") prefillRemoteRuleCandidate(ui?._pendingCandidateIndex);
      else if (action === "remote-rule-ignore") await ignoreRemoteRuleCandidate(ui?._pendingCandidateIndex);
      else if (action === "ignore-restore-folder") await restoreIgnoredFolder(ui?._pendingIgnoredFolder);
      else if (action === "ignore-restore-title") await restoreIgnoredRemoteTitle(ui?._pendingIgnoredTitleIndex);
      else if (action === "ignore-register-folder") await registerIgnoredFolder(ui?._pendingFolderPath);
      else if (action === "ignore-register-title") await registerIgnoredRemoteTitle(ui?._pendingIgnoredTitleIndex);
      else if (action === "ignore-delete-empty-folder") { await removeEmptyDiscoveredFolder(ui?._pendingFolderPath); renderIgnoredItems(); }
      else if (action === "extract-preview") await toggleExtractionPreview();
      else if (action === "extract-back-filter") setExtractScene("filter",-1);
      else if (action === "extract-next-output") {
        if (!selectedExtractionEntries().length) throw new Error("至少选择一个对话，再进入下一步");
        setExtractScene("output",1);
      }
      else if (action === "extract-back-results") setExtractScene("results",-1);
      else if (action === "extract-generate") await generateExtractionPackage();
      else if (action === "extract-choose-entry") await chooseExtractionEntryDirectory();
      else if (action === "extract-delete-last") await deleteLastExtraction();
      else if (action === "extract-new") resetExtractionComplete();
      else if (action === "extract-select-all") {
        const inputs = [...ui.extractList.querySelectorAll('[data-role="extract-select"]')];
        const select = inputs.some((input) => !input.checked);
        for (const input of inputs) input.checked = select;
      }
      else if (action === "folder-reconcile") await reconcileRegisteredFolderMoves();
      else if (action === "folder-register") prefillRuleFromFolder(ui?._pendingFolderPath);
      else if (action === "folder-organize") selectConversationIssuesForFolder(ui?._pendingFolderPath);
      else if (action === "folder-ignore") { await ignoreDiscoveredFolder(ui?._pendingFolderPath); routeManageAfterAudit(ui?._folderAudit); }
      else if (action === "folder-delete-empty") { await removeEmptyDiscoveredFolder(ui?._pendingFolderPath); routeManageAfterAudit(ui?._folderAudit); }
      else if (action === "folder-empty-delete") { await applyEmptyFolderDecision(ui?._pendingFolderPath,"delete"); routeManageAfterAudit(ui?._folderAudit); }
      else if (action === "folder-empty-mirror") { await applyEmptyFolderDecision(ui?._pendingFolderPath,"mirror"); routeManageAfterAudit(ui?._folderAudit); }
      else if (action === "folder-empty-ignore") { await ignoreEmptyFolderDecision(ui?._pendingFolderPath); routeManageAfterAudit(ui?._folderAudit); }
      else if (action === "issue-select-all") {
        const inputs = [...ui.issueList.querySelectorAll('[data-role="issue-select"]')];
        const select = inputs.some((input) => !input.checked);
        for (const input of inputs) input.checked = select;
      }
      else if (action === "issue-preview") buildSelectedMigrationPreview();
      else if (action === "issue-apply") { await applySelectedConversationRule(); routeManageAfterAudit(ui?._folderAudit); }
      else if (action === "rule-add") {
        const sourceFolder = String(ui?._discoveredFolderPath || "");
        const returnScene = ui?._ruleReturnScene || (sourceFolder ? "discover" : "rules");
        await addClassificationRule();
        renderClassificationRules();
        if (sourceFolder && returnScene === "discover") routeManageAfterAudit(ui?._folderAudit);
        else if (sourceFolder && returnScene === "ignored") { renderIgnoredItems(); setManageScene("ignored",-1); }
        else setManageScene("rules",-1);
      }
      else if (action === "rule-edit") editClassificationRule(ui?._pendingEditRuleId);
      else if (action === "rule-delete") { await deleteClassificationRule(ui?._pendingDeleteRuleId); renderClassificationRules(); }
      else if (action === "choose") {
        const handle = await chooseDirectory();
        await refreshRuleFolderChoices({ interactive:false });
        setStatus(`本地资料库已选择：${handle.name || "已授权目录"}`, "ok");
      } else if (action === "rebuild") await runRebuild();
      else if (action === "clear") {
        if (window.confirm("清除目录授权句柄和插件配置？本地导出文件不会被删除。")) {
          await idbClear();
          localStorage.removeItem(RULES_STORAGE_KEY);
          localStorage.removeItem(EXTRACT_ENTRY_STATE_KEY);
          for (const key of LEGACY_RULES_STORAGE_KEYS) localStorage.removeItem(key);
          cachedDirectoryHandle = null;
          if (ui) ui._extractEntryHandle = null;
          directoryHandleLoaded = true;
          updateDirectoryDisplay();
          updateExtractionOutputDisplay();
          setStatus("插件配置已清除；本地文件未删除。","ok");
        }
      }
    } catch (error) {
      const cancelled = cancelRequested || /取消|AbortError/.test(`${error?.name} ${error?.message}`);
      if (action === "sync") {
        setStatus(cancelled ? "导出已取消\n尚未确认安全落盘的内容不会覆盖本地文件。" : `导出失败\n${error?.message || error}`,"error");
      } else {
        setStatus(cancelled ? "操作已取消；已经完整保存的文件会保留。" : `操作失败\n${error?.message || error}`,cancelled ? "warning" : "error");
      }
    } finally {
      running = false;
      cancelRequested = false;
      updateBusy();
      syncMainViewHeight();
    }
  }
  function prefersReducedMotion() {
    try { return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches); }
    catch { return false; }
  }

  function animateAttention(element, { subtle = false } = {}) {
    if (!element || prefersReducedMotion() || typeof element.animate !== "function") return;
    element.animate(
      subtle
        ? [{ transform:"translate3d(0,5px,0) scale(.994)" }, { transform:"translate3d(0,0,0) scale(1)" }]
        : [{ transform:"scale(.988)" }, { transform:"scale(1.006)" }, { transform:"scale(1)" }],
      { duration: subtle ? 180 : 320, easing:"cubic-bezier(.2,.8,.2,1)" },
    );
  }

  function setStatus(text, kind = "normal", cancellable = false) {
    createUi();
    const wasHidden = ui.status.hidden;
    const previousKind = ui.status.dataset.kind || "";
    ui.status.hidden = false;
    ui.status.textContent = text;
    ui.status.dataset.kind = kind;
    ui.cancel.hidden = !cancellable;
    if (wasHidden || previousKind !== kind) animateAttention(ui.status, { subtle:true });
  }

  function updateBusy() {
    if (!ui) return;
    for (const button of ui.shadow.querySelectorAll("button[data-action]:not([data-action='cancel'])")) button.disabled = running;
    ui.trigger.setAttribute("aria-busy", running ? "true" : "false");
    ui.panel?.toggleAttribute("data-busy", running);
  }

  function managePendingCounts(audit = ui?._folderAudit) {
    const changes = audit?.stateChangeResult?.changes || audit?.conversationChanges || [];
    const missing = audit?.missingFileIssues || [];
    const folders = (audit?.folderChanges || []).filter((item) => item.type === "decide-empty-folder");
    const issues = (audit?.conversationIssues || []).filter((issue) => !isMissingOnlyIssue(issue));
    const discoveries = audit?.unregisteredFolders || [];
    const stateCount = changes.length + missing.length + folders.length;
    return {
      state: stateCount,
      organizer: issues.length,
      discoveries: discoveries.length,
      blocking: stateCount + issues.length,
      total: stateCount + issues.length + discoveries.length,
    };
  }

  function updateManageHomeSummary(audit = ui?._folderAudit) {
    if (!ui?.manageStatusTitle || !ui?.manageStatusCopy) return;
    if (!audit) {
      ui.manageStatusTitle.textContent = "还没有检查本地变化";
      ui.manageStatusCopy.textContent = "在文件管理器里移动、删除或新建目录后，点一次“检查变化”。";
      return;
    }
    const counts = managePendingCounts(audit);
    if (!counts.total) {
      ui.manageStatusTitle.textContent = "文件都整理好了";
      ui.manageStatusCopy.textContent = "JSON 和 Markdown 没有需要你处理的变化。";
    } else if (counts.blocking) {
      ui.manageStatusTitle.textContent = `还有 ${counts.blocking} 件事需要确认`;
      ui.manageStatusCopy.textContent = counts.discoveries ? `另外还有 ${counts.discoveries} 个新目录，可登记也可忽略。` : "一次只处理当前这一件。";
    } else {
      ui.manageStatusTitle.textContent = `发现 ${counts.discoveries} 个新目录`;
      ui.manageStatusCopy.textContent = "这些只是整理建议，不影响导出；可以登记，也可以忽略。";
    }
  }

  function sceneMap(kind) {
    if (!ui) return {};
    const stage = kind === "manage" ? ui.manageStage : ui.extractStage;
    if (!stage) return {};
    return Object.fromEntries([...stage.querySelectorAll(`[data-${kind}-scene]`)].map((node) => [node.dataset[`${kind}Scene`], node]));
  }

  function syncMainViewHeight() {
    if (!ui?.viewStage) return;
    const views = { export:ui.exportView, manage:ui.manageView, extract:ui.extractView };
    const current = views[ui._mainView || "export"];
    if (!current) return;
    requestAnimationFrame(() => {
      const height = Math.max(1, current.scrollHeight);
      ui.viewStage.style.height = `${height}px`;
    });
  }

  function setScene(kind, name, direction = 1, { focus = null } = {}) {
    if (!ui) return;
    const stage = kind === "manage" ? ui.manageStage : ui.extractStage;
    const key = kind === "manage" ? "_manageScene" : "_extractScene";
    const scenes = sceneMap(kind);
    const next = scenes[name];
    if (!stage || !next) return;
    const previousName = ui[key] && scenes[ui[key]] ? ui[key] : name;
    const previous = scenes[previousName];

    if (previous === next) {
      for (const [sceneName, element] of Object.entries(scenes)) {
        element.hidden = sceneName !== name;
        element.inert = sceneName !== name;
      }
      ui[key] = name;
      if (focus) requestAnimationFrame(() => focus.focus({ preventScroll:true }));
      syncMainViewHeight();
      return;
    }

    const reduce = prefersReducedMotion() || typeof next.animate !== "function";
    const oldHeight = previous?.offsetHeight || stage.offsetHeight || 1;
    next.hidden = false;
    next.inert = false;
    next.style.position = "absolute";
    next.style.inset = "0 auto auto 0";
    next.style.width = "100%";
    next.style.visibility = "hidden";
    const nextHeight = Math.max(1, next.scrollHeight);
    next.style.visibility = "";
    stage.style.height = `${oldHeight}px`;
    // 先提交旧高度，再切到目标高度，确保 CSS height transition 真正发生，而不是结束时突然跳高。
    void stage.offsetHeight;
    stage.style.height = `${nextHeight}px`;

    if (previous) previous.inert = true;
    if (!reduce && previous) {
      // 进入和退出从同一帧开始，不再故意空等 65ms；让下一场景立即接住视线。
      previous.animate(
        [{ transform:"translate3d(0,0,0) scale(1)", opacity:1 }, { transform:`translate3d(${-14 * direction}px,0,0) scale(.994)`, opacity:.10 }],
        { duration:180, easing:"cubic-bezier(.4,0,.6,1)", fill:"both" },
      );
      next.animate(
        [{ transform:`translate3d(${20 * direction}px,0,0) scale(.992)`, opacity:.66 }, { transform:"translate3d(0,0,0) scale(1)", opacity:1 }],
        { duration:230, easing:"cubic-bezier(.2,.8,.2,1)", fill:"both" },
      );
    }

    ui[key] = name;
    window.setTimeout(() => {
      for (const [sceneName, element] of Object.entries(scenes)) {
        element.hidden = sceneName !== name;
        element.inert = sceneName !== name;
        element.style.position = "";
        element.style.inset = "";
        element.style.width = "";
        element.getAnimations?.().forEach((animation) => animation.cancel());
      }
      stage.style.height = "";
      if (focus) focus.focus({ preventScroll:true });
      syncMainViewHeight();
    }, reduce ? 0 : 240);
  }

  function setManageScene(name, direction = 1, options = {}) {
    setScene("manage", name, direction, options);
  }

  function setExtractScene(name, direction = 1, options = {}) {
    setScene("extract", name, direction, options);
  }

  function routeManageAfterAudit(audit = ui?._folderAudit) {
    updateManageHomeSummary(audit);
    const counts = managePendingCounts(audit);
    if (counts.state) setManageScene("changes", 1);
    else if (counts.organizer) setManageScene("organizer", 1);
    else if (counts.discoveries) setManageScene("discover", 1);
    else setManageScene("home", -1);
  }

  function setMainView(view) {
    if (!ui) return;
    const selected = ["export","manage","extract"].includes(view) ? view : "export";
    const order = ["export","manage","extract"];
    const index = order.indexOf(selected);
    if (ui.tabs) ui.tabs.dataset.activeView = selected;
    if (ui.exportTab) ui.exportTab.dataset.active = selected === "export" ? "true" : "false";
    if (ui.manageTab) ui.manageTab.dataset.active = selected === "manage" ? "true" : "false";
    if (ui.extractTab) ui.extractTab.dataset.active = selected === "extract" ? "true" : "false";
    ui._mainView = selected;
    if (ui.viewTrack) ui.viewTrack.style.transform = `translate3d(${-100 * index}%,0,0)`;
    for (const [name, element] of Object.entries({export:ui.exportView,manage:ui.manageView,extract:ui.extractView})) {
      if (!element) continue;
      element.inert = name !== selected;
      element.setAttribute("aria-hidden", name === selected ? "false" : "true");
    }
    syncMainViewHeight();
  }

  async function setPanelOpen(open) {
    if (!ui?.panel) return;
    if (ui._panelAnimation) {
      try { ui._panelAnimation.cancel(); } catch {}
      ui._panelAnimation = null;
    }
    if (open) {
      if (!ui.panel.hidden) return;
      ui.panel.hidden = false;
      ui.trigger.setAttribute("aria-expanded","true");
      updateDirectoryDisplay();
      const directory = cachedDirectoryHandle;
      if (directory) readSharedClassificationRules(directory).then(() => { renderIgnoredItems(); renderClassificationRules(); }).catch(() => {});
      syncMainViewHeight();
      if (!prefersReducedMotion() && typeof ui.panel.animate === "function") {
        ui._panelAnimation = ui.panel.animate(
          [{ transform:"translate3d(14px,-3px,0) scale(.975)", opacity:.42 }, { transform:"translate3d(0,0,0) scale(1)", opacity:1 }],
          { duration:230, easing:"cubic-bezier(.2,.8,.2,1)" },
        );
        try { await ui._panelAnimation.finished; } catch {}
        ui._panelAnimation = null;
      }
      return;
    }

    if (ui.panel.hidden) return;
    ui.trigger.setAttribute("aria-expanded","false");
    if (!prefersReducedMotion() && typeof ui.panel.animate === "function") {
      ui._panelAnimation = ui.panel.animate(
        [{ transform:"translate3d(0,0,0) scale(1)", opacity:1 }, { transform:"translate3d(14px,-3px,0) scale(.975)", opacity:.18 }],
        { duration:175, easing:"cubic-bezier(.4,0,.8,.2)" },
      );
      try { await ui._panelAnimation.finished; } catch {}
      ui._panelAnimation = null;
    }
    ui.panel.hidden = true;
  }

  function createUi() {
    if (ui || document.getElementById(HOST_ID)) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position:fixed;right:14px;top:92px;z-index:2147483647";
    document.body.insertAdjacentElement("beforeend", host);
    const shadow = host.attachShadow({ mode:"open" });
    shadow.innerHTML = `
      <style>
        :host{all:initial}*{box-sizing:border-box;letter-spacing:0}
        :host,button,input,select{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
        .trigger{width:38px;height:38px;padding:0;border:1px solid rgba(15,23,42,.14);border-radius:12px;background:rgba(20,24,34,.94);color:#fff;font:600 17px/1 system-ui;cursor:pointer;box-shadow:0 8px 24px rgba(15,23,42,.20),inset 0 1px rgba(255,255,255,.12);transition:transform 150ms cubic-bezier(.2,.8,.2,1),box-shadow 150ms ease}
        .trigger:hover{transform:translateY(-1px);box-shadow:0 10px 28px rgba(15,23,42,.25),inset 0 1px rgba(255,255,255,.12)}.trigger:active{transform:scale(.96)}
        .panel{--bg:#f4f5f7;--surface:#fff;--surface-2:#f7f8fa;--text:#17191f;--muted:#6f7480;--line:#e3e5e9;--accent:#5955d8;--accent-soft:#efefff;--accent-strong:#4440ba;--ok:#16794b;--ok-soft:#edf8f2;--warn:#986300;--warn-soft:#fff8e7;--danger:#b42318;--danger-soft:#fff1f0;position:absolute;right:48px;top:0;width:min(500px,calc(100vw - 78px));max-height:min(780px,calc(100vh - 112px));overflow:auto;overscroll-behavior:contain;padding:0 16px 16px;border:1px solid rgba(15,23,42,.10);border-radius:20px;background:var(--bg);color:var(--text);box-shadow:0 24px 70px rgba(15,23,42,.22),0 2px 10px rgba(15,23,42,.08);font:13px/1.55 system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;scrollbar-width:thin;transform-origin:top right}
        .panel[hidden],[hidden]{display:none!important}.panel[data-busy] .topbar::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:workline 1.1s linear infinite}@keyframes workline{from{transform:translateX(-70%)}to{transform:translateX(70%)}}
        h2,h3,p{margin:0}h2{font-size:16px;line-height:1.25;font-weight:730}h3{font-size:14px;line-height:1.35;font-weight:720}
        .topbar{position:sticky;top:0;z-index:30;margin:0 -16px 12px;padding:15px 16px 10px;background:color-mix(in srgb,var(--bg) 93%,transparent);backdrop-filter:blur(16px) saturate(1.12);border-bottom:1px solid rgba(15,23,42,.06)}
        .brandline{display:flex;align-items:center;justify-content:space-between;gap:12px}.brand-meta{color:var(--muted);font-size:10px;font-weight:600;white-space:nowrap}
        .tabs{display:flex;gap:5px;margin-top:12px;padding:4px;border:1px solid rgba(15,23,42,.08);border-radius:14px;background:rgba(255,255,255,.62);overflow:hidden}
        .tabs button{display:flex;align-items:center;justify-content:center;gap:7px;flex:1 1 0;min-width:0;min-height:38px;padding:7px 8px;border:0;border-radius:10px;background:transparent;color:var(--muted);box-shadow:none;font:650 12px/1 system-ui;cursor:pointer;transition:flex-grow 300ms cubic-bezier(.2,.8,.2,1),background 220ms ease,color 180ms ease,box-shadow 220ms ease,transform 140ms ease}
        .tabs button[data-active="true"]{flex-grow:3.15;background:var(--surface);color:var(--text);box-shadow:0 2px 9px rgba(15,23,42,.10),0 0 0 1px rgba(15,23,42,.04)}
        .tabs button:active{transform:scale(.975)}.tab-hint{max-width:0;opacity:0;overflow:hidden;white-space:nowrap;color:var(--muted);font-size:10px;transition:max-width 260ms cubic-bezier(.2,.8,.2,1),opacity 180ms ease}.tabs button[data-active="true"] .tab-hint{max-width:86px;opacity:1}
        .status{position:relative;z-index:24;margin:0 0 12px;padding:9px 11px;border:1px solid var(--line);border-radius:11px;background:rgba(255,255,255,.94);color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 6px 18px rgba(15,23,42,.07);font-size:11.5px}.status[data-kind="ok"]{background:var(--ok-soft);border-color:#cfe9da}.status[data-kind="warning"]{background:var(--warn-soft);border-color:#eedda9}.status[data-kind="error"]{background:var(--danger-soft);border-color:#f3c8c4}.cancel{width:100%;margin:0 0 12px}
        .view-stage{position:relative;overflow:clip;border-radius:16px;transition:height 270ms cubic-bezier(.2,.8,.2,1)}.view-track{display:flex;align-items:flex-start;width:100%;will-change:transform;transition:transform 360ms cubic-bezier(.2,.8,.2,1)}.view{flex:0 0 100%;min-width:0;display:grid;gap:12px}
        .scene-stage{position:relative;min-width:0;transition:height 240ms cubic-bezier(.2,.8,.2,1)}.scene{display:grid;gap:12px;min-width:0}
        .task-hero,.scene-card,.state-changes,.folder-discovery,.organizer,.rule-editor,.ignored-panel{position:relative;overflow:hidden;padding:15px;border:1px solid var(--line);border-radius:16px;background:var(--surface);box-shadow:0 1px 2px rgba(15,23,42,.035)}
        .task-hero::after{content:"";position:absolute;width:120px;height:120px;right:-54px;top:-60px;border-radius:50%;background:radial-gradient(circle,var(--accent-soft),transparent 68%);pointer-events:none}
        .eyebrow{color:var(--accent-strong);font-size:10px;font-weight:780;letter-spacing:.07em}.hero-title{margin-top:4px;font-size:19px;font-weight:770;letter-spacing:-.02em}.hero-copy{margin-top:5px;color:var(--muted);font-size:11px;max-width:38em}
        .location-shell{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:13px;padding:10px 11px;border-radius:11px;background:var(--surface-2);border:1px solid #edf0f3}.location-copy{display:grid;gap:1px;min-width:0}.location-label{color:var(--muted);font-size:10px;font-weight:650}.directory-line{color:#474b55;font-size:11px;overflow-wrap:anywhere}
        .scene-top{position:sticky;top:108px;z-index:22;display:flex;align-items:center;justify-content:space-between;gap:10px;margin:-3px -3px 0;padding:7px 3px 8px;background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(14px) saturate(1.08);border-bottom:1px solid rgba(15,23,42,.055)}.back-button{min-height:30px!important;padding:5px 8px!important;border-color:transparent!important;background:transparent!important;color:var(--accent-strong)!important}.scene-title{display:grid;gap:2px}.scene-kicker{color:var(--muted);font-size:10px;font-weight:700}.progress-pill{padding:4px 7px;border-radius:999px;background:var(--surface-2);color:var(--muted);font-size:10px;font-weight:650}
        .focus-item{display:grid;gap:12px;padding:4px 0}.span-all{grid-column:1/-1}.row-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.row-actions button{min-height:30px;padding:5px 8px;font-size:11px}.focus-item>div:first-child{display:grid;gap:4px}.focus-item strong{font-size:15px}.focus-item span{color:var(--muted);font-size:11px;overflow-wrap:anywhere}.focus-item.conflict strong{color:var(--warn)}.focus-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
        .home-status{display:grid;gap:5px}.home-status strong{font-size:15px}.home-status span{color:var(--muted);font-size:11px}
        .hub-list{display:grid;gap:8px}.hub-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:9px;align-items:center;text-align:left;min-height:48px;padding:10px 12px}.hub-row .hub-copy{display:grid;gap:2px}.hub-row .hub-copy strong{font-size:12px}.hub-row .hub-copy span{color:var(--muted);font-size:10.5px}.hub-row .count{color:var(--muted);font-size:10.5px}.chevron{color:var(--muted);font-size:20px;line-height:1}
        button{min-height:36px;padding:8px 10px;border:1px solid #d8dbe2;border-radius:10px;background:var(--surface);color:var(--text);font:620 12px/1.2 system-ui;cursor:pointer;transition:transform 130ms cubic-bezier(.2,.8,.2,1),background 140ms ease,border-color 140ms ease,box-shadow 140ms ease}button:hover{background:#f7f8fa;border-color:#c9cdd6}button:active{transform:scale(.975)}button:disabled{opacity:.5;cursor:wait;transform:none}.btn-primary,button[data-action="sync"],button[data-action="extract-generate"]{background:var(--accent);color:#fff;border-color:var(--accent);box-shadow:0 5px 14px rgba(91,87,217,.18)}.btn-primary:hover,button[data-action="sync"]:hover,button[data-action="extract-generate"]:hover{background:var(--accent-strong);border-color:var(--accent-strong)}.btn-danger{color:var(--danger)}
        .primary{display:grid;grid-template-columns:1fr 1fr;gap:8px}.primary.one{grid-template-columns:1fr}.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:9px}.head-copy{display:grid;gap:2px}.hint,.muted{color:var(--muted);font-size:10.5px}
        .settings{display:grid;gap:9px}.field{display:grid;gap:4px;font-size:11px;color:#4a4e58;font-weight:630}.field[hidden]{display:none!important}input,select{width:100%;min-height:35px;padding:7px 9px;border:1px solid #d8dbe2;border-radius:9px;background:var(--surface);color:var(--text);font:500 12px/1.25 system-ui;outline:none;transition:border-color 140ms ease,box-shadow 140ms ease}input:focus,select:focus{border-color:#aba8ef;box-shadow:0 0 0 3px rgba(91,87,217,.10)}.delimiter-row{display:grid;grid-template-columns:1fr 1fr;gap:7px}.check{display:flex;align-items:flex-start;gap:7px;color:#4a4e58;font-size:11px}.check input{width:16px;height:16px;min-height:16px;margin:1px 0 0;accent-color:var(--accent)}
        .format-preview,.issue-preview{margin:3px 0;padding:10px;border-radius:10px;background:var(--surface-2);white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;border:1px solid #eceef2;font-size:10.5px}.rules-list{display:grid;gap:7px}.rule-row{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;padding:10px 11px}.rule-main{display:grid;gap:2px;min-width:0}.rule-main strong,.rule-main span{overflow-wrap:anywhere}.rule-main span{color:var(--muted);font-size:10.5px}
        .candidate-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;align-items:center;padding:9px 0;border-top:1px solid var(--line)}.candidate-row:first-child{border-top:0}.candidate-row>div{display:grid;gap:2px}.candidate-row span{color:var(--muted);font-size:10.5px}.issue-list{display:grid;max-height:300px;overflow:auto;border-top:1px solid var(--line)}.issue-row{display:grid;grid-template-columns:20px minmax(0,1fr);gap:7px;padding:8px 0;border-bottom:1px solid var(--line);align-items:start}.issue-row input{width:16px;min-height:16px;margin:3px 0 0;accent-color:var(--accent)}.issue-row span{display:grid}.issue-row small{color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
        .extract-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.extract-grid .wide{grid-column:1/-1}.extract-list{display:grid;max-height:360px;overflow:auto;border-top:1px solid var(--line);margin-top:8px}.extract-row{display:grid;grid-template-columns:20px minmax(0,1fr);gap:7px;padding:8px 0;border-bottom:1px solid var(--line)}.extract-row input{width:16px;min-height:16px;margin:3px 0 0;accent-color:var(--accent)}.extract-row span{display:grid}.extract-row small{color:var(--muted)}.entry-card{padding:10px;border-radius:11px;background:var(--surface-2);border:1px solid #eceef2}.entry-card+.entry-card{margin-top:8px}.empty-state{display:grid;gap:3px;padding:14px 4px;color:var(--muted)}.empty-state strong{color:var(--text);font-size:12px}
        .global-maintenance{margin-top:12px;border:0;background:transparent}.global-maintenance>summary{cursor:pointer;color:var(--muted);font-size:10.5px;padding:7px 2px}.global-maintenance .settings{padding-top:8px}
        @media(prefers-color-scheme:dark){.panel{--bg:#17191e;--surface:#202329;--surface-2:#272a31;--text:#f3f4f6;--muted:#a2a7b2;--line:#343842;--accent:#8580ff;--accent-soft:#2d2b4b;--accent-strong:#aaa6ff;--ok:#69d39c;--ok-soft:#1d2d26;--warn:#f0bc57;--warn-soft:#302819;--danger:#ff8d83;--danger-soft:#33201f}.tabs{background:rgba(32,35,41,.75);border-color:#333741}.location-shell,.entry-card,.format-preview,.issue-preview{border-color:#343842}button:hover{background:#2a2e36;border-color:#454a56}input,select{border-color:#404550}.directory-line,.field,.check{color:#c5c9d1}}
        @media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}}
      </style>

      <button class="trigger" title="AI 对话流转" aria-label="打开 AI 对话流转工具" aria-expanded="false">⇄</button>
      <section class="panel" hidden>
        <div class="topbar">
          <div class="brandline"><h2>AI 对话流转</h2><span class="brand-meta">本地工作台 · v${VERSION}</span></div>
          <div class="tabs" data-role="tabs" data-active-view="export">
            <button data-action="view-export" data-role="tab-export" data-active="true"><span>导出</span><span class="tab-hint">收进本地</span></button>
            <button data-action="view-manage" data-role="tab-manage" data-active="false"><span>管理</span><span class="tab-hint">整理对话</span></button>
            <button data-action="view-extract" data-role="tab-extract" data-active="false"><span>提取</span><span class="tab-hint">拿去使用</span></button>
          </div>
        </div>

        <div class="status" hidden></div>
        <button class="cancel" data-action="cancel" hidden>停止当前操作</button>

        <div class="view-stage" data-role="view-stage">
          <div class="view-track" data-role="view-track">
            <section class="view" data-role="view-export">
              <div class="task-hero">
                <div class="eyebrow">导出</div>
                <div class="hero-title">把网页对话收进本地</div>
                <p class="hero-copy">只处理新增或有变化的对话；已经在本地的内容不会反复下载。</p>
                <div class="location-shell">
                  <div class="location-copy"><span class="location-label">本地资料库</span><span class="directory-line" data-role="export-directory-name">尚未选择</span></div>
                  <button data-action="choose">更换位置</button>
                </div>
                <div class="primary one" style="margin-top:12px"><button class="btn-primary" data-action="sync">开始导出</button></div>
              </div>
            </section>

            <section class="view" data-role="view-manage" aria-hidden="true">
              <div class="scene-stage" data-role="manage-stage">
                <section class="scene" data-manage-scene="home">
                  <div class="task-hero">
                    <div class="eyebrow">管理</div>
                    <div class="hero-title">整理本地对话</div>
                    <p class="hero-copy">你在文件管理器里移动、删除或新建目录后，在这里检查一次。能确定的变化会自动处理。</p>
                    <div class="location-shell">
                      <div class="location-copy"><span class="location-label">正在管理</span><span class="directory-line" data-role="manage-directory-name">尚未选择本地资料库</span></div>
                      <button class="btn-primary" data-action="folder-scan">检查变化</button>
                    </div>
                  </div>
                  <div class="scene-card home-status">
                    <span class="scene-kicker">当前状态</span>
                    <strong data-role="manage-status-title">还没有检查本地变化</strong>
                    <span data-role="manage-status-copy">在文件管理器里动过文件后，点一次“检查变化”。</span>
                  </div>
                  <div class="hub-list">
                    <button class="hub-row" data-action="manage-rules"><span class="hub-copy"><strong>分类规则</strong><span>决定哪些命名自动放进哪些文件夹</span></span><span class="count" data-role="rule-count">0 条</span><span class="chevron">›</span></button>
                    <button class="hub-row" data-action="manage-ignored" data-role="manage-ignored-button" hidden><span class="hub-copy"><strong>之前忽略的项目</strong><span>需要时可以回来登记</span></span><span class="count" data-role="ignored-count">0 项</span><span class="chevron">›</span></button>
                  </div>
                </section>

                <section class="scene" data-manage-scene="changes" hidden>
                  <div class="scene-top"><button class="back-button" data-action="manage-home">‹ 管理</button><span class="progress-pill" data-role="state-changes-progress"></span></div>
                  <section class="state-changes" data-role="state-changes">
                    <div class="scene-title"><span class="scene-kicker">需要你决定</span><h3>只看当前这一件</h3></div>
                    <div data-role="state-changes-list"></div>
                  </section>
                </section>

                <section class="scene" data-manage-scene="discover" hidden>
                  <div class="scene-top"><button class="back-button" data-action="manage-home">‹ 管理</button><span class="progress-pill" data-role="folder-discovery-progress"></span></div>
                  <section class="folder-discovery" data-role="folder-discovery">
                    <div class="scene-title"><span class="scene-kicker">发现新目录</span><h3>要不要把它变成一个分类？</h3></div>
                    <div data-role="folder-discovery-list"></div>
                  </section>
                </section>

                <section class="scene" data-manage-scene="organizer" hidden>
                  <div class="scene-top"><button class="back-button" data-action="manage-home">‹ 管理</button><span class="progress-pill">位置冲突</span></div>
                  <section class="organizer" data-role="organizer">
                    <div class="scene-title"><span class="scene-kicker">最终位置</span><h3>选择这些对话最后放在哪里</h3></div>
                    <div class="settings" style="margin-top:10px">
                      <div class="primary"><button data-action="issue-select-all">全选 / 取消</button><select data-role="issue-target-rule"><option value="">选择最终分类</option></select></div>
                      <div class="issue-list" data-role="issue-list"></div>
                      <pre class="issue-preview" data-role="issue-preview" hidden></pre>
                      <div class="primary"><button data-action="issue-preview">看一下会怎么整理</button><button class="btn-primary" data-action="issue-apply">确认整理</button></div>
                    </div>
                  </section>
                </section>

                <section class="scene" data-manage-scene="rules" hidden>
                  <div class="scene-top"><button class="back-button" data-action="manage-home">‹ 管理</button><button data-action="rules-new">新建分类</button></div>
                  <div class="scene-card">
                    <div class="card-head"><div class="head-copy"><span class="scene-kicker">分类规则</span><h3>命名和文件夹的对应关系</h3></div><button data-action="remote-title-scan">检查网页标题</button></div>
                    <div data-role="remote-rule-candidates" hidden></div>
                    <div class="rules-list" data-role="rules-list"></div>
                  </div>
                </section>

                <section class="scene" data-manage-scene="rule-editor" hidden>
                  <div class="scene-top"><button class="back-button" data-action="rules-back" data-role="rule-back-button">‹ 分类规则</button><span class="progress-pill">编辑</span></div>
                  <section class="rule-editor" data-role="rule-details">
                    <div class="scene-title"><span class="scene-kicker">分类设置</span><h3>这一类对话以后放到哪里</h3></div>
                    <div class="settings" style="margin-top:10px">
                      <label class="field">命名标记<input data-role="rule-field" placeholder="例如：SP" /></label>
                      <label class="field">标记后面怎么分隔<div class="delimiter-row"><select data-role="rule-connector"><option value="__unset__">请选择</option><option value="__none__">无连接符</option><option value="__space__">普通空格</option><option value="-">- 横杠</option><option value="/">/ 斜杠</option><option value="_">_ 下划线</option><option value="：">：中文冒号</option><option value="__custom__">自定义</option></select><input data-role="rule-connector-custom" placeholder="输入自定义连接符" hidden /></div></label>
                      <label class="field">放进哪个一级文件夹<div class="delimiter-row"><input data-role="rule-root-folder" placeholder="例如：视频项目" /><select data-role="rule-root-folder-choice"><option value="">选择已有一级文件夹</option></select></div></label>
                      <label class="field">需要子文件夹吗<div class="delimiter-row"><select data-role="rule-folder-separator"><option value="__unset__">请选择</option><option value="__none__">不使用子文件夹</option><option value="/">使用 / 划分（推荐）</option><option value="-">使用 - 划分</option><option value="_">使用 _ 划分</option><option value="__space__">使用普通空格划分</option><option value="__custom__">使用自定义符号</option></select><input data-role="rule-folder-separator-custom" placeholder="输入自定义分隔符" hidden /></div></label>
                      <label class="field" data-role="rule-subfolder-field" hidden>放进哪个子文件夹<div class="delimiter-row"><input data-role="rule-subfolder-path" placeholder="例如：一级分类/二级分类" /><select data-role="rule-subfolder-choice"><option value="">选择已有子文件夹</option></select></div><span class="hint">可以手填，也可以直接选择已有目录。</span></label>
                      <div class="format-preview" data-role="rule-preview" data-kind="error">先填写规则，这里会显示最终放到哪里。</div>
                      <label class="check"><input type="checkbox" data-role="keep-old-alias" />修改规则时继续识别旧格式</label>
                      <div class="primary"><button data-action="rule-delete-current" data-role="rule-delete-current">取消</button><button class="btn-primary" data-action="rule-add" data-role="rule-save">新增规则并创建文件夹</button></div>
                    </div>
                  </section>
                </section>

                <section class="scene" data-manage-scene="ignored" hidden>
                  <div class="scene-top"><button class="back-button" data-action="manage-home">‹ 管理</button><span class="progress-pill">已忽略</span></div>
                  <section class="ignored-panel" data-role="ignored-details"><div data-role="ignored-list"></div></section>
                </section>
              </div>
            </section>

            <section class="view" data-role="view-extract" aria-hidden="true">
              <div class="scene-stage" data-role="extract-stage">
                <section class="scene" data-extract-scene="filter">
                  <div class="task-hero">
                    <div class="eyebrow">提取</div>
                    <div class="hero-title">先挑出要拿走的对话</div>
                    <p class="hero-copy">这一步只负责筛选。看完结果以后，再决定怎么拿走。</p>
                    <div class="location-shell"><div class="location-copy"><span class="location-label">来源</span><span class="directory-line" data-role="extract-directory-name">尚未选择本地资料库</span></div></div>
                  </div>
                  <div class="scene-card">
                    <div class="extract-grid">
                      <label class="field">时间<select data-role="extract-time"><option value="all">全部时间</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="custom">自定义</option></select></label>
                      <label class="field">命名标记<select data-role="extract-field"><option value="">全部命名</option></select></label>
                      <label class="field" data-role="extract-start-field" hidden>开始日期<input type="date" data-role="extract-start" /></label>
                      <label class="field" data-role="extract-end-field" hidden>结束日期<input type="date" data-role="extract-end" /></label>
                      <label class="field wide">文件夹<select data-role="extract-folder"><option value="">全部文件夹</option></select></label>
                      <label class="check wide"><input type="checkbox" data-role="extract-subfolders" checked />包含里面的子文件夹</label>
                      <label class="field wide">标题搜索<input data-role="extract-keyword" placeholder="可留空，也可以输入标题或对话 ID" /></label>
                      <div class="wide"><span class="scene-kicker">带哪些文件</span><div style="display:flex;gap:18px;margin-top:6px"><label class="check"><input type="checkbox" data-role="extract-json" checked />JSON</label><label class="check"><input type="checkbox" data-role="extract-markdown" checked />Markdown</label></div></div>
                    </div>
                    <div class="primary one" style="margin-top:11px"><button class="btn-primary" data-action="extract-preview" data-role="extract-preview-button">查看筛选结果</button></div>
                  </div>
                </section>

                <section class="scene" data-extract-scene="results" hidden>
                  <div class="scene-top"><button class="back-button" data-action="extract-back-filter">‹ 修改筛选</button><span class="progress-pill">第 2 步</span></div>
                  <section class="scene-card" data-role="extract-results">
                    <div class="card-head"><div class="head-copy"><span class="scene-kicker">筛选结果</span><h3 data-role="extract-summary">找到的对话</h3></div><button data-action="extract-select-all">全选 / 取消</button></div>
                    <div class="extract-list" data-role="extract-list"></div>
                    <div class="primary one" style="margin-top:11px"><button class="btn-primary" data-action="extract-next-output">下一步：怎么拿走</button></div>
                  </section>
                </section>

                <section class="scene" data-extract-scene="output" hidden>
                  <div class="scene-top"><button class="back-button" data-action="extract-back-results">‹ 筛选结果</button><span class="progress-pill">第 3 步</span></div>
                  <section class="scene-card">
                    <div class="scene-title"><span class="scene-kicker">怎么拿走</span><h3>选择形式和快捷入口</h3></div>
                    <div class="extract-grid" style="margin-top:10px">
                      <label class="field">形式<select data-role="extract-output-kind"><option value="zip">ZIP 压缩包</option><option value="folder">普通文件（直接拖）</option></select></label>
                      <label class="field">这次叫什么<input data-role="extract-package-name" placeholder="可留空，自动命名" /></label>
                      <div class="wide entry-card"><div class="card-head"><div class="head-copy"><strong>快捷入口</strong><span class="hint">只保留最新一次，打开后可以直接全选拖走。</span></div><span class="directory-line" data-role="extract-entry-location">还没设置</span></div><button data-action="extract-choose-entry">选择 / 更换快捷入口</button></div>
                      <div class="wide entry-card"><div class="card-head"><div class="head-copy"><strong>提取历史</strong><span class="hint">每次另外留一份，需要时再回来找。</span></div><span class="directory-line" data-role="extract-history-location">当前资料库 / 提取历史</span></div></div>
                    </div>
                    <div class="primary one" style="margin-top:11px"><button class="btn-primary" data-action="extract-generate">开始提取</button></div>
                  </section>
                </section>

                <section class="scene" data-extract-scene="complete" hidden>
                  <section class="scene-card" data-role="extract-complete">
                    <div class="scene-title"><span class="scene-kicker">完成</span><h3>这一批已经准备好</h3></div>
                    <div class="directory-line" data-role="extract-complete-text" style="margin-top:10px"></div>
                    <div class="primary" style="margin-top:11px"><button class="btn-danger" data-action="extract-delete-last" data-role="extract-delete-history">删除这次历史记录</button><button class="btn-primary" data-action="extract-new">继续提取</button></div>
                  </section>
                </section>
              </div>
            </section>
          </div>
        </div>

        <details class="global-maintenance"><summary>维护与修复</summary><div class="settings"><button data-action="health">检查工具状态</button><button data-action="rebuild">重新读取本地档案</button><button class="btn-danger" data-action="clear">重置工具设置</button></div></details>
      </section>`;

    ui = {
      host, shadow, trigger:shadow.querySelector(".trigger"), panel:shadow.querySelector(".panel"),
      status:shadow.querySelector(".status"), cancel:shadow.querySelector(".cancel"),
      tabs:shadow.querySelector('[data-role="tabs"]'), viewStage:shadow.querySelector('[data-role="view-stage"]'), viewTrack:shadow.querySelector('[data-role="view-track"]'),
      exportView:shadow.querySelector('[data-role="view-export"]'), manageView:shadow.querySelector('[data-role="view-manage"]'), extractView:shadow.querySelector('[data-role="view-extract"]'),
      exportTab:shadow.querySelector('[data-role="tab-export"]'), manageTab:shadow.querySelector('[data-role="tab-manage"]'), extractTab:shadow.querySelector('[data-role="tab-extract"]'),
      manageStage:shadow.querySelector('[data-role="manage-stage"]'), extractStage:shadow.querySelector('[data-role="extract-stage"]'),
      manageStatusTitle:shadow.querySelector('[data-role="manage-status-title"]'), manageStatusCopy:shadow.querySelector('[data-role="manage-status-copy"]'),
      ruleCount:shadow.querySelector('[data-role="rule-count"]'), ignoredCount:shadow.querySelector('[data-role="ignored-count"]'), manageIgnoredButton:shadow.querySelector('[data-role="manage-ignored-button"]'),
      stateChangesProgress:shadow.querySelector('[data-role="state-changes-progress"]'), folderDiscoveryProgress:shadow.querySelector('[data-role="folder-discovery-progress"]'),
      exportDirectoryName:shadow.querySelector('[data-role="export-directory-name"]'), manageDirectoryName:shadow.querySelector('[data-role="manage-directory-name"]'), extractDirectoryName:shadow.querySelector('[data-role="extract-directory-name"]'),
      stateChanges:shadow.querySelector('[data-role="state-changes"]'), stateChangesList:shadow.querySelector('[data-role="state-changes-list"]'),
      folderDiscovery:shadow.querySelector('[data-role="folder-discovery"]'), folderDiscoveryList:shadow.querySelector('[data-role="folder-discovery-list"]'),
      organizer:shadow.querySelector('[data-role="organizer"]'), issueList:shadow.querySelector('[data-role="issue-list"]'), issueTargetRule:shadow.querySelector('[data-role="issue-target-rule"]'), issuePreview:shadow.querySelector('[data-role="issue-preview"]'),
      ruleDetails:shadow.querySelector('[data-role="rule-details"]'), remoteRuleCandidates:shadow.querySelector('[data-role="remote-rule-candidates"]'),
      ruleField:shadow.querySelector('[data-role="rule-field"]'), ruleConnector:shadow.querySelector('[data-role="rule-connector"]'), ruleConnectorCustom:shadow.querySelector('[data-role="rule-connector-custom"]'),
      ruleRootFolder:shadow.querySelector('[data-role="rule-root-folder"]'), ruleRootFolderChoice:shadow.querySelector('[data-role="rule-root-folder-choice"]'),
      ruleFolderSeparator:shadow.querySelector('[data-role="rule-folder-separator"]'), ruleFolderSeparatorCustom:shadow.querySelector('[data-role="rule-folder-separator-custom"]'),
      ruleSubfolderField:shadow.querySelector('[data-role="rule-subfolder-field"]'), ruleSubfolderPath:shadow.querySelector('[data-role="rule-subfolder-path"]'), ruleSubfolderChoice:shadow.querySelector('[data-role="rule-subfolder-choice"]'),
      rulePreview:shadow.querySelector('[data-role="rule-preview"]'), keepOldAlias:shadow.querySelector('[data-role="keep-old-alias"]'), ruleSave:shadow.querySelector('[data-role="rule-save"]'), ruleDeleteCurrent:shadow.querySelector('[data-role="rule-delete-current"]'), ruleBackButton:shadow.querySelector('[data-role="rule-back-button"]'), rulesList:shadow.querySelector('[data-role="rules-list"]'),
      ignoredDetails:shadow.querySelector('[data-role="ignored-details"]'), ignoredList:shadow.querySelector('[data-role="ignored-list"]'),
      extractTime:shadow.querySelector('[data-role="extract-time"]'), extractField:shadow.querySelector('[data-role="extract-field"]'), extractStartField:shadow.querySelector('[data-role="extract-start-field"]'), extractEndField:shadow.querySelector('[data-role="extract-end-field"]'),
      extractStart:shadow.querySelector('[data-role="extract-start"]'), extractEnd:shadow.querySelector('[data-role="extract-end"]'), extractFolder:shadow.querySelector('[data-role="extract-folder"]'), extractIncludeSubfolders:shadow.querySelector('[data-role="extract-subfolders"]'),
      extractKeyword:shadow.querySelector('[data-role="extract-keyword"]'), extractJson:shadow.querySelector('[data-role="extract-json"]'), extractMarkdown:shadow.querySelector('[data-role="extract-markdown"]'), extractOutputKind:shadow.querySelector('[data-role="extract-output-kind"]'), extractPackageName:shadow.querySelector('[data-role="extract-package-name"]'),
      extractEntryLocation:shadow.querySelector('[data-role="extract-entry-location"]'), extractHistoryLocation:shadow.querySelector('[data-role="extract-history-location"]'), extractPreviewButton:shadow.querySelector('[data-role="extract-preview-button"]'),
      extractResults:shadow.querySelector('[data-role="extract-results"]'), extractSummary:shadow.querySelector('[data-role="extract-summary"]'), extractList:shadow.querySelector('[data-role="extract-list"]'), extractComplete:shadow.querySelector('[data-role="extract-complete"]'), extractCompleteText:shadow.querySelector('[data-role="extract-complete-text"]'), extractDeleteHistoryButton:shadow.querySelector('[data-role="extract-delete-history"]'),
      _pendingDeleteRuleId:"",_pendingEditRuleId:"",_pendingFolderPath:"",_pendingConversationId:"",_pendingCandidateIndex:"",_pendingIgnoredFolder:"",_pendingIgnoredTitleIndex:"",
      _editingRuleId:"",_discoveredFolderPath:"",_folderAudit:null,_remoteRuleCandidates:[],_ruleFolderPaths:[],_extractCandidates:null,_extractIndex:null,_extractDirty:true,_extractEntryHandle:null,_lastExtraction:null,
      _mainView:"export",_manageScene:"home",_extractScene:"filter",_ruleReturnScene:"rules",_panelAnimation:null,_viewResizeObserver:null,
    };

    renderClassificationRules();
    renderIgnoredItems();
    updateRulePreview();
    updateManageHomeSummary();
    setMainView("export");
    updateDirectoryDisplay();
    updateExtractionOutputDisplay();

    if (typeof ResizeObserver !== "undefined") {
      ui._viewResizeObserver = new ResizeObserver(() => syncMainViewHeight());
      for (const view of [ui.exportView,ui.manageView,ui.extractView]) if (view) ui._viewResizeObserver.observe(view);
    }

    idbGetStoredHandle(IDB_EXTRACT_ENTRY_KEY).then((handle) => {
      if (!ui || !handle) return;
      ui._extractEntryHandle = handle;
      updateExtractionOutputDisplay();
    }).catch(() => {});

    ui.trigger.addEventListener("click", () => { void setPanelOpen(ui.panel.hidden); });
    shadow.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      if (button.dataset.action === "rule-delete") ui._pendingDeleteRuleId = button.dataset.ruleId || "";
      if (button.dataset.action === "rule-edit") ui._pendingEditRuleId = button.dataset.ruleId || "";
      if ((button.dataset.action.startsWith("folder-") || button.dataset.action.startsWith("ignore-")) && button.dataset.folderPath) ui._pendingFolderPath = button.dataset.folderPath || "";
      if (["state-apply","issue-delete"].includes(button.dataset.action)) ui._pendingConversationId = button.dataset.conversationId || "";
      if (["remote-rule-prefill","remote-rule-ignore"].includes(button.dataset.action)) ui._pendingCandidateIndex = button.dataset.candidateIndex || "";
      if (button.dataset.action === "ignore-restore-folder") ui._pendingIgnoredFolder = button.dataset.folderPath || "";
      if (button.dataset.action === "ignore-restore-title" || button.dataset.action === "ignore-register-title") ui._pendingIgnoredTitleIndex = button.dataset.ignoreIndex || "";
      runAction(button.dataset.action);
    });
    shadow.addEventListener("input", (event) => {
      if (event.target === ui.ruleRootFolder) populateRuleSubfolderChoices();
      if (event.target.matches("[data-role^='rule-']")) updateRulePreview();
      if ([ui.extractStart,ui.extractEnd,ui.extractKeyword].includes(event.target)) invalidateExtractionPreview();
    });
    shadow.addEventListener("change", (event) => {
      if (event.target === ui.ruleConnector) {
        ui.ruleConnectorCustom.hidden = ui.ruleConnector.value !== "__custom__";
        if (!ui.ruleConnectorCustom.hidden) ui.ruleConnectorCustom.focus();
      }
      if (event.target === ui.ruleFolderSeparator) {
        ui.ruleFolderSeparatorCustom.hidden = ui.ruleFolderSeparator.value !== "__custom__";
        if (!ui.ruleFolderSeparatorCustom.hidden) ui.ruleFolderSeparatorCustom.focus();
      }
      if (event.target === ui.ruleRootFolderChoice && ui.ruleRootFolderChoice.value) {
        ui.ruleRootFolder.value = ui.ruleRootFolderChoice.value;
        populateRuleSubfolderChoices();
      }
      if (event.target === ui.ruleSubfolderChoice && ui.ruleSubfolderChoice.value) {
        ui.ruleSubfolderPath.value = ui.ruleSubfolderChoice.value;
        if (["__unset__","__none__"].includes(ui.ruleFolderSeparator.value)) setDelimiterForm(ui.ruleFolderSeparator,ui.ruleFolderSeparatorCustom,"/");
        ui.ruleSubfolderField.hidden = false;
      }
      if (event.target.matches("[data-role^='rule-'], [data-role='keep-old-alias']")) updateRulePreview();
      if (event.target === ui.extractTime) {
        const custom = ui.extractTime.value === "custom";
        ui.extractStartField.hidden = !custom;
        ui.extractEndField.hidden = !custom;
      }
      if ([ui.extractTime,ui.extractField,ui.extractFolder,ui.extractIncludeSubfolders,ui.extractJson,ui.extractMarkdown].includes(event.target)) invalidateExtractionPreview();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!ui.panel.hidden && !event.composedPath().includes(host)) void setPanelOpen(false);
    }, true);
  }
  function initializeLocalSync() {
    createUi();
    idbGetHandle().then((handle) => {
      if (!directoryHandleLoaded) {
        cachedDirectoryHandle = handle;
        directoryHandleLoaded = true;
        updateDirectoryDisplay();
        if (handle) verifyPermission(handle, false).then((ok) => ok ? ensureArchiveStructure(handle) : null).catch(() => {});
      }
    }).catch(() => {
      if (!directoryHandleLoaded) directoryHandleLoaded = true;
      updateDirectoryDisplay();
    });
    window.setInterval(function restoreInterfaceIfRemoved() {
      if (!document.getElementById(HOST_ID)) {
        ui = null;
        createUi();
      }
    }, 3000);
  }

  const startWhenDocumentIsReady = () => initializeLocalSync();
  if (document.readyState !== "loading") startWhenDocumentIsReady();
  else window.addEventListener("DOMContentLoaded", startWhenDocumentIsReady, { once: true });
})();


