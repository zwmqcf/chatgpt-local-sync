// ==UserScript==
// @name         AI 对话流转｜ChatGPT 对话导出与整理
// @namespace    local.only.chatgpt.incremental.exporter
// @version      2.9.85
// @description  将 ChatGPT 对话增量同步到本地；提供 00/01/02/03/10/11/12/90 资料库视图、双来源提取与安全旧库升级向导。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document_idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const VERSION = "2.9.85";
  const SCHEMA_VERSION = "2.4";
  const INDEX_SCHEMA_VERSION = "1.0";
  const INACTIVE_DAYS = 7;
  const DAY_MS = 86_400_000;
  const RAW_ROOT = "00_原始";
  const JSON_ROOT = "01_JSON";
  const MARKDOWN_ROOT = "02_Markdown";
  const PDF_ROOT = "03_PDF";
  const PROJECT_ROOT = "10_项目";
  const SYSTEM_ARCHIVE_FOLDER = "11_归档";
  const SYSTEM_DELETED_FOLDER = "12_已删除";
  const ENGINEERING_ROOT = "90_工程文件";
  const META_DIR = `${ENGINEERING_ROOT}/内部状态`;
  const PUBLIC_INDEX_PATH = `${ENGINEERING_ROOT}/conversation-index.json`;
  const TIMELINE_PATH = `${ENGINEERING_ROOT}/timeline.json`;
  const LEGACY_META_DIR = ".chatgpt-export";
  const IDB_NAME = "chatgpt-local-exporter";
  const IDB_STORE = "handles";
  const IDB_HANDLE_KEY = "export-root";
  const IDB_EXTRACT_ENTRY_KEY = "extract-entry";
  const EXTRACT_ENTRY_STATE_KEY = "chatgpt-local-exporter-extract-entry-state-v1";
  const EXTRACT_UI_STATE_KEY = "chatgpt-local-exporter-extract-ui-state-v1";
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
  const EXTRACTION_HISTORY_FOLDER = `${ENGINEERING_ROOT}/提取历史`;
  const EXTRACTION_HISTORY_META_DIR = `${META_DIR}/extraction-history`;
  const VIEW_MIGRATION_STATE_PATH = `${META_DIR}/migrations/2.9.7-views.json`;
  const LIBRARY_UPGRADE_RECEIPT_PATH = `${META_DIR}/migrations/2.9.81-library-upgrade.json`;
  const LIBRARY_UPGRADE_STAGING_PATH = `${META_DIR}/migrations/2.9.81-library-upgrade-staging.json`;
  const ASSET_LEDGER_PATH = `${META_DIR}/asset-ledger.json`;
  const TASK_LOG_ROOT_2983 = `${ENGINEERING_ROOT}/任务日志`;
  const OBJECT_TRACE_ROOT_2983 = `${ENGINEERING_ROOT}/对象追踪`;
  const TASK_CHECKPOINT_ROOT_2983 = `${ENGINEERING_ROOT}/任务检查点`;
  const DIAGNOSTIC_PACK_ROOT_2983 = `${ENGINEERING_ROOT}/诊断包`;
  const LIBRARY_LAYOUT_VERSION_2983 = "numbered-v1";
  const VIEW_RENDER_VERSION_2983 = "clean-chat-pdf-katex-v3-inline";
  const USER_CONFIG_CONFLICT_ROOT_2984 = `${ENGINEERING_ROOT}/用户配置冲突待确认`;
  const USER_CONFIG_CONFLICT_MANIFEST_2984 = `${META_DIR}/user-config-conflicts.json`;
  const TASK_LOG_BATCH_EVENTS_2983 = 32;
  const TASK_LOG_BATCH_MS_2983 = 1500;
  const TASK_REDACT_KEYS_2983 = new Set(["body","raw","messages","payload","conversation_body","conversation_body_json","content","authorization","cookie","token","access_token","accesstoken"]);
  let taskSequence2983 = 0;
  let activeTaskRun2983 = null;
  const taskRuntime2983 = { tasks:new Map(), latestTaskId:null };
  const taskRecoveryCheckedAt2983 = new WeakMap();

  function taskRuntimeSnapshot2983() {
    return {
      latest_task_id:taskRuntime2983.latestTaskId,
      tasks:[...taskRuntime2983.tasks.values()].map((task)=>({ task_id:task.log?.task_id || null, task_type:task.log?.task_type || null, state:task.state || task.log?.status || 'unknown', started_at:task.log?.started_at || null, ended_at:task.log?.ended_at || null })),
    };
  }

  function taskSafeName2983(value, fallback = "task") {
    const cleaned = String(value || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    return (cleaned || fallback).slice(0, 96);
  }

  function taskStableHash2983(value) {
    let hash = 2166136261;
    for (const ch of String(value || "")) { hash ^= ch.codePointAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
    return hash.toString(16).padStart(8,"0");
  }

  function sanitizeTaskValue2983(value, key = "") {
    const normalizedKey = String(key || "").toLowerCase();
    if (TASK_REDACT_KEYS_2983.has(normalizedKey)) return "[redacted]";
    if (Array.isArray(value)) return value.map((item) => sanitizeTaskValue2983(item));
    if (value && typeof value === "object") {
      const out = {};
      for (const [childKey, childValue] of Object.entries(value)) out[childKey] = sanitizeTaskValue2983(childValue, childKey);
      return out;
    }
    return value;
  }

  function taskLogPath2983(task) {
    const date = String(task?.log?.started_at || new Date().toISOString()).slice(0,10) || "unknown-date";
    return `${TASK_LOG_ROOT_2983}/${date}/${taskSafeName2983(task?.log?.task_type)}_${taskSafeName2983(task?.log?.task_id)}.json`;
  }

  function taskMarkdownPath2983(task) { return taskLogPath2983(task).replace(/\.json$/i,".md"); }
  function taskCheckpointPath2983(task) { return `${TASK_CHECKPOINT_ROOT_2983}/${taskSafeName2983(task?.log?.task_id)}.json`; }

  function normalizeTaskEvent2983(event = {}) {
    const objectType = String(event.object_type || event.objectType || (event.conversation_id || event.conversation_uid ? "conversation" : event.attachment_id ? "attachment" : event.file_id ? "file" : event.source_path || event.target_path ? "asset" : "") || "") || null;
    const objectId = event.object_id || event.objectId || event.conversation_uid || event.conversation_id || event.attachment_id || event.file_id || event.target_path || event.source_path || null;
    return sanitizeTaskValue2983({
      ...event,
      ...(objectType ? { object_type:objectType } : {}),
      ...(objectId ? { object_id:String(objectId) } : {}),
      at:event.at || new Date().toISOString(),
    });
  }

  function createTaskRun2983(taskType, { trigger = "user", context = null, root = null } = {}) {
    taskSequence2983 += 1;
    const startedAt = new Date().toISOString();
    const taskId = `${taskSafeName2983(taskType)}_${Date.now().toString(36)}_${taskSequence2983.toString(36)}`;
    const task = {
      log:{
        schema_version:"1.0", app_version:VERSION, task_id:taskId, task_type:String(taskType || "task"), trigger:String(trigger || "user"),
        started_at:startedAt, updated_at:startedAt, ended_at:null, status:"running", context:sanitizeTaskValue2983(context), summary:null, error:null, events:[], diagnostic_warnings:[],
      },
      root:root || null, dirtyEvents:0, lastFlushAt:0, flushTimer:null, flushChain:Promise.resolve(), traces:new Map(), dirtyTraceKeys:new Set(), checkpoint:null, state:"running",
    };
    taskRuntime2983.tasks.set(taskId,task);
    taskRuntime2983.latestTaskId=taskId;
    taskEvent2983(task,{type:"task_started",stage:"start",status:"running"});
    return task;
  }

  function isCriticalTaskEvent2983(event = {}) {
    const type=String(event.type || "").toLowerCase();
    const status=String(event.status || "").toLowerCase();
    const level=String(event.level || "").toLowerCase();
    const stage=String(event.stage || "").toLowerCase();
    if (event.critical === true || event.error_code || event.conflict) return true;
    if (["error","warning"].includes(level)) return true;
    if (["failed","error","warning","conflict","paused","cancelled","interrupted"].includes(status)) return true;
    if (type === "task_finished" || stage === "finish") return true;
    return /failure|failed|error|conflict/.test(type);
  }

  function objectTracePath2983(task, trace) {
    const date = String(task?.log?.started_at || new Date().toISOString()).slice(0,10) || "unknown-date";
    const id = String(trace?.object_id || "object");
    return `${OBJECT_TRACE_ROOT_2983}/${date}/${taskSafeName2983(task?.log?.task_id)}/${taskSafeName2983(trace?.object_type,"object")}_${taskSafeName2983(id,"object")}_${taskStableHash2983(id)}.json`;
  }

  function recordObjectTrace2983(task, event, { persist = false } = {}) {
    if (!task || !event?.object_type || !event?.object_id) return;
    const key = `${event.object_type}:${event.object_id}`;
    let trace = task.traces.get(key);
    if (!trace) {
      trace = { schema_version:"1.0", app_version:VERSION, task_id:task.log.task_id, task_type:task.log.task_type, started_at:task.log.started_at, object_type:event.object_type, object_id:String(event.object_id), name:event.name || event.title || event.filename || null, events:[] };
      task.traces.set(key,trace);
    }
    trace.events.push({ ...event, sequence:trace.events.length + 1, stage:event.stage || event.phase || event.status || event.type || "event" });
    if (persist) task.dirtyTraceKeys.add(key);
  }

  function taskEvent2983(task, event = {}) {
    if (!task?.log) return null;
    const normalized = normalizeTaskEvent2983(event);
    task.log.events.push(normalized);
    task.log.updated_at = normalized.at || new Date().toISOString();
    task.dirtyEvents += 1;
    const critical=isCriticalTaskEvent2983(normalized);
    recordObjectTrace2983(task, normalized, { persist:critical });
    if (critical) void flushTaskRun2983(task,{force:true,writeTraces:true});
    else scheduleTaskFlush2983(task);
    return normalized;
  }

  function scheduleTaskFlush2983(task) {
    if (!task?.root || task.flushTimer) return;
    if (task.dirtyEvents >= TASK_LOG_BATCH_EVENTS_2983) { void flushTaskRun2983(task,{force:true}); return; }
    task.flushTimer = setTimeout(() => { task.flushTimer = null; void flushTaskRun2983(task,{force:true}); }, TASK_LOG_BATCH_MS_2983);
  }

  function renderTaskMarkdown2983(task) {
    const log = task?.log || {};
    const lines = [`# ${log.task_type || "任务"}`,"",`- task_id: ${log.task_id || ""}`,`- version: ${log.app_version || VERSION}`,`- status: ${log.status || "unknown"}`,`- started_at: ${log.started_at || ""}`,`- ended_at: ${log.ended_at || ""}`];
    if (log.summary) lines.push("", "## Summary", "", "```json", JSON.stringify(log.summary,null,2), "```");
    if (log.error) lines.push("", "## Error", "", "```json", JSON.stringify(log.error,null,2), "```");
    const noteworthy = (log.events || []).filter((event) => isCriticalTaskEvent2983(event) || event.type === "task_started" || event.type === "task_finished");
    if (noteworthy.length) {
      lines.push("", "## Events", "");
      for (const event of noteworthy) lines.push(`- ${event.at || ""} · ${event.stage || event.type || "event"}${event.object_type && event.object_id ? ` · ${event.object_type}:${event.object_id}` : ""}${event.error_code ? ` · ${event.error_code}` : ""}${event.message ? ` · ${String(event.message).replace(/\s+/g," ").slice(0,500)}` : ""}`);
    }
    return `${lines.join("\n")}\n`;
  }

  async function attachTaskIo2983(task, root) {
    if (!task) return task;
    task.root = root || null;
    if (task.root) await flushTaskRun2983(task,{force:true,writeTraces:true});
    return task;
  }

  async function flushTaskRun2983(task, { force = false, writeTraces = false } = {}) {
    if (!task?.log || !task.root) return task;
    if (!force && task.dirtyEvents < TASK_LOG_BATCH_EVENTS_2983 && Date.now() - Number(task.lastFlushAt || 0) < TASK_LOG_BATCH_MS_2983) return task;
    if (task.flushTimer) { clearTimeout(task.flushTimer); task.flushTimer = null; }
    task.flushChain = task.flushChain.then(async () => {
      try {
        task.log.updated_at = new Date().toISOString();
        await writeText(task.root,taskLogPath2983(task),`${JSON.stringify(sanitizeTaskValue2983(task.log),null,2)}\n`);
        await writeText(task.root,taskMarkdownPath2983(task),renderTaskMarkdown2983(task));
        if (task.checkpoint) await writeText(task.root,taskCheckpointPath2983(task),`${JSON.stringify(sanitizeTaskValue2983(task.checkpoint),null,2)}\n`);
        if (writeTraces || task.dirtyTraceKeys.size) {
          const keys = [...task.dirtyTraceKeys];
          task.dirtyTraceKeys.clear();
          for (const key of keys) {
            const trace = task.traces.get(key); if (!trace) continue;
            await writeText(task.root,objectTracePath2983(task,trace),`${JSON.stringify(sanitizeTaskValue2983(trace),null,2)}\n`);
          }
        }
        task.dirtyEvents = 0; task.lastFlushAt = Date.now();
      } catch (error) {
        task.log.diagnostic_warnings.push({at:new Date().toISOString(),code:error?.code || error?.name || "diagnostic_write_failed",message:error?.message || String(error)});
        console.warn("AI 对话流转：任务日志写入失败，不影响主任务",error);
      }
    });
    await task.flushChain;
    return task;
  }

  async function writeTaskCheckpoint2983(task, checkpoint = {}, { force = false } = {}) {
    if (!task?.log) return null;
    task.checkpoint = { schema_version:"1.0", task_id:task.log.task_id, task_type:task.log.task_type, updated_at:new Date().toISOString(), ...sanitizeTaskValue2983(checkpoint) };
    const marker=`${task.checkpoint.phase || ""} ${task.checkpoint.status || ""}`.toLowerCase();
    if (force || /paused|cancelled|interrupted|complete|finish|failed|conflict/.test(marker)) await flushTaskRun2983(task,{force:true,writeTraces:true});
    else scheduleTaskFlush2983(task);
    return task.checkpoint;
  }

  async function finishTaskRun2983(task, status, { summary = null, error = null } = {}) {
    if (!task?.log) return null;
    task.log.status = String(status || "succeeded"); task.state=task.log.status; task.log.ended_at = new Date().toISOString(); task.log.summary = sanitizeTaskValue2983(summary); task.log.error = sanitizeTaskValue2983(error);
    taskRuntime2983.tasks.set(task.log.task_id,task); taskRuntime2983.latestTaskId=task.log.task_id;
    taskEvent2983(task,{type:"task_finished",stage:"finish",status:task.log.status,...(error ? {error_code:error?.code || error?.name || "task_failed",message:error?.message || String(error)} : {})});
    await flushTaskRun2983(task,{force:true,writeTraces:true});
    return task.log;
  }

  const TASK_ACTION_TYPES_2983 = Object.freeze({
    health:"health-check", sync:"full-save", "folder-scan":"folder-scan", "views-backfill":"view-backfill",
    "state-apply":"apply-local-change", "issue-delete":"confirm-delete", "state-apply-all":"apply-local-changes",
    "remote-title-scan":"remote-title-scan", "remote-rule-ignore":"remote-rule-ignore", "ignore-restore-folder":"restore-ignored-folder",
    "ignore-restore-title":"restore-ignored-title", "ignore-register-folder":"ignore-folder", "ignore-register-title":"ignore-title",
    "ignore-delete-empty-folder":"delete-empty-folder", "extract-preview":"extraction-preview", "extract-generate":"extraction-generate",
    "extract-choose-entry":"extraction-entry-change", "extract-delete-last":"extraction-history-delete", "folder-reconcile":"folder-reconcile",
    "folder-ignore":"folder-ignore", "folder-delete-empty":"folder-delete-empty", "folder-empty-delete":"folder-empty-delete",
    "folder-empty-mirror":"folder-empty-mirror", "folder-empty-ignore":"folder-empty-ignore", "issue-preview":"migration-preview",
    "issue-apply":"migration-apply", "rule-add":"rule-save", "rule-delete":"rule-delete", "rule-delete-current":"rule-delete",
    "upgrade-new-directory":"library-upgrade-new-directory", "upgrade-in-place":"library-upgrade-in-place", "upgrade-resolve-conflict":"library-upgrade-conflict-resolution",
    rebuild:"rebuild-index", clear:"reset-plugin-settings", "diagnostic-pack":"diagnostic-pack",
  });

  function taskTypeForAction2983(action) { return TASK_ACTION_TYPES_2983[String(action || "")] || null; }

  async function readRecentTaskLogs2983(root, { limit = 10 } = {}) {
    if (!root) return [];
    const rows=[];
    try {
      const logRoot = await getDirectory(root,TASK_LOG_ROOT_2983,false);
      for await (const entry of walkDirectory(logRoot)) {
        if (entry?.handle?.kind !== "file" || !/\.json$/i.test(entry.path)) continue;
        rows.push({path:`${TASK_LOG_ROOT_2983}/${entry.path}`,handle:entry.handle});
      }
    } catch (error) { if (error?.name !== "NotFoundError") console.warn("读取任务日志失败",error); }
    rows.sort((a,b)=>b.path.localeCompare(a.path));
    const out=[];
    for (const row of rows.slice(0,Math.max(0,Number(limit)||0))) {
      try { out.push({path:row.path,log:JSON.parse(await (await row.handle.getFile()).text())}); } catch { /* malformed historical diagnostic */ }
    }
    return out.sort((a,b)=>String(b.log?.ended_at || b.log?.updated_at || b.log?.started_at || "").localeCompare(String(a.log?.ended_at || a.log?.updated_at || a.log?.started_at || "")));
  }

  async function recoverInterruptedTaskLogs2983(root, { staleMs = 60000, force = false } = {}) {
    if (!root || (typeof root !== "object" && typeof root !== "function")) return 0;
    const nowMs=Date.now();
    const prior=taskRecoveryCheckedAt2983.get(root) || 0;
    if (!force && nowMs-prior < 10000) return 0;
    taskRecoveryCheckedAt2983.set(root,nowMs);
    const rows=await readRecentTaskLogs2983(root,{limit:50});
    let recovered=0;
    let needsDelayedCheck=false;
    for (const row of rows) {
      const log=row?.log;
      if (!log || log.status !== "running" || log.task_id === activeTaskRun2983?.log?.task_id) continue;
      const updatedMs=Date.parse(log.updated_at || log.started_at || "");
      const age=Number.isFinite(updatedMs) ? nowMs-updatedMs : Number.POSITIVE_INFINITY;
      if (age < staleMs) { needsDelayedCheck=true; continue; }
      const at=new Date().toISOString();
      log.status="interrupted"; log.ended_at=at; log.updated_at=at;
      if (!Array.isArray(log.events)) log.events=[];
      log.events.push(normalizeTaskEvent2983({type:"task_interrupted",stage:"recovery",status:"interrupted",error_code:"runtime_disappeared",message:"检测到上一次任务未正常结束；已标记为中断。",at}));
      await writeText(root,row.path,`${JSON.stringify(sanitizeTaskValue2983(log),null,2)}\n`);
      await writeText(root,row.path.replace(/\.json$/i,".md"),renderTaskMarkdown2983({log}));
      recovered++;
    }
    if (needsDelayedCheck && !force) setTimeout(()=>{ void recoverInterruptedTaskLogs2983(root,{staleMs,force:true}); },Math.max(1000,staleMs));
    return recovered;
  }

  async function createDiagnosticPack2983(root, { limit = 20 } = {}) {
    if (!root) throw new Error("请先选择资料库");
    const entries=[];
    const includePrefixes=[TASK_LOG_ROOT_2983,OBJECT_TRACE_ROOT_2983,TASK_CHECKPOINT_ROOT_2983];
    for (const prefix of includePrefixes) {
      try {
        const dir=await getDirectory(root,prefix,false);
        const files=[];
        for await (const entry of walkDirectory(dir)) if (entry?.handle?.kind === "file") files.push(entry);
        files.sort((a,b)=>b.path.localeCompare(a.path));
        for (const entry of files.slice(0,Math.max(1,Number(limit)||20)*8)) {
          const bytes=new Uint8Array(await (await entry.handle.getFile()).arrayBuffer());
          entries.push({name:`diagnostics/${prefix.replace(`${ENGINEERING_ROOT}/`,"")}/${entry.path}`,data:bytes});
        }
      } catch (error) { if (error?.name !== "NotFoundError") console.warn(`诊断包读取 ${prefix} 失败`,error); }
    }
    for (const path of [LIBRARY_UPGRADE_RECEIPT_PATH,LIBRARY_UPGRADE_STAGING_PATH,VIEW_MIGRATION_STATE_PATH,ASSET_LEDGER_PATH,PUBLIC_INDEX_PATH,TIMELINE_PATH]) {
      try {
        const bytes=await readBytes281(root,path); if (!bytes) continue;
        if (path === PUBLIC_INDEX_PATH || path === TIMELINE_PATH) {
          const parsed=JSON.parse(new TextDecoder().decode(bytes));
          const summary=path===PUBLIC_INDEX_PATH
            ? {schema_version:parsed?.schema_version||null,exporter_version:parsed?.exporter_version||null,updated_at:parsed?.updated_at||null,conversation_count:Array.isArray(parsed?.conversations)?parsed.conversations.length:Object.keys(parsed?.conversations||{}).length}
            : {generated_at:parsed?.generated_at||parsed?.updated_at||null,item_count:Array.isArray(parsed)?parsed.length:Array.isArray(parsed?.items)?parsed.items.length:null};
          entries.push({name:`manifests/${path.split('/').pop().replace(/\.json$/i,'')}_summary.json`,data:new TextEncoder().encode(`${JSON.stringify(summary,null,2)}\n`)});
        } else entries.push({name:`manifests/${path.split('/').pop()}`,data:bytes});
      } catch (error) { entries.push({name:`manifests/read_error_${taskStableHash2983(path)}.json`,data:new TextEncoder().encode(`${JSON.stringify({path,error_code:error?.code||error?.name||"read_failed",message:error?.message||String(error)},null,2)}\n`)}); }
    }
    const metadata={schema_version:"1.0",app_version:VERSION,generated_at:new Date().toISOString(),conversation_bodies_included:false,redaction:"body/raw/messages/payload/auth/cookie/token excluded",entry_count:entries.length};
    entries.unshift({name:'diagnostic-metadata.json',data:new TextEncoder().encode(`${JSON.stringify(metadata,null,2)}\n`)});
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const outputPath=`${DIAGNOSTIC_PACK_ROOT_2983}/诊断_${stamp}.zip`;
    await writeBinary(root,outputPath,createStoreZip(entries));
    return {path:outputPath,entry_count:entries.length,conversation_bodies_included:false};
  }

  async function showRecentTaskLogs2983() {
    const directory=await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason || "未获得资料库目录");
    const rows=await readRecentTaskLogs2983(directory.handle,{limit:8});
    if (!rows.length) { setStatus(`还没有任务日志。\n以后执行保存、迁移、提取、修复等工作都会写到 ${TASK_LOG_ROOT_2983}。`,"normal"); return rows; }
    const lines=["最近任务日志",...rows.map(({path,log})=>`${String(log?.started_at||"").replace('T',' ').slice(0,19)}  ${log?.task_type||"task"}  ${log?.status||"unknown"}\n${path}`)];
    setStatus(lines.join("\n\n"),rows.some(({log})=>["failed","interrupted"].includes(log?.status))?"warning":"normal");
    return rows;
  }

  const LEGACY_ARCHIVE_FOLDER = "Archive";
  const LEGACY_DELETED_FOLDER = "Deleted";

  function needsLibraryUpgrade281(probe = {}) {
    return Boolean(probe?.hasPluginEvidence && !probe?.receiptComplete);
  }

  function defaultUpgradeMode281() { return "new-directory"; }

  function canCommitLibraryUpgrade281(result = {}) {
    const total = Number(result?.total || 0);
    return Boolean(result?.complete && Number(result?.verified || 0) === total && Number(result?.failed || 0) === 0 && Number(result?.conflicts || 0) === 0);
  }

  function canResumeUpgradeTarget281(staging, sourceFingerprint) {
    return Boolean(staging && staging.complete !== true && String(staging.source_fingerprint || "") === String(sourceFingerprint || ""));
  }

  function isProvenManagedAsset281(path, knownPaths) {
    const normalized = String(path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return Boolean(normalized && knownPaths && typeof knownPaths.has === "function" && knownPaths.has(normalized));
  }

  function isUserManagedConfigTarget2984(targetPath) {
    return normalizeStatePath(targetPath || "") === normalizeStatePath(SHARED_RULES_PATH);
  }

  function isConversationManagedAsset2984(candidate = {}) {
    if (managedConversationAssetType2984(candidate?.target_path || candidate?.source_path || "") === "conversation-pdf") return false;
    return String(candidate?.asset_type || "") === "conversation";
  }

  function managedConversationAssetType2984(path) {
    const normalized=normalizeStatePath(path || "");
    return /\.pdf$/i.test(normalized) ? "conversation-pdf" : "conversation";
  }

  function migrationConflictPolicy2984(targetPath, candidates = []) {
    const normalizedTarget = normalizeStatePath(targetPath || "");
    const rows = Array.isArray(candidates) ? candidates : [];
    const current = rows.find((item) => normalizeStatePath(item?.source_path || "") === normalizedTarget) || null;
    if (rows.some(isConversationManagedAsset2984)) {
      return { action:"ask-user", blocking:true, requires_user_review:true, selected:null, backups:[] };
    }
    if (isUserManagedConfigTarget2984(normalizedTarget) && current) {
      return {
        action:"preserve-active-user-config", blocking:false, requires_user_review:true, selected:current,
        backups:rows.filter((item) => item !== current),
      };
    }
    if (current) {
      return {
        action:"prefer-current-engineering", blocking:false, requires_user_review:false, selected:current,
        backups:[],
      };
    }
    return { action:"ask-user", blocking:true, requires_user_review:true, selected:null, backups:[] };
  }

  function userConfigConflictsFromMigration2984(copyResult = {}, detectedAt = new Date().toISOString()) {
    const plans=Array.isArray(copyResult?.preflight?.plans) ? copyResult.preflight.plans : [];
    const records=Array.isArray(copyResult?.records) ? copyResult.records : [];
    const out=[];
    for (const plan of plans) {
      const targetPath=normalizeStatePath(plan?.target_path || "");
      const targetBackups=records.filter((record)=>record?.status === "verified-user-config-backup" && normalizeStatePath(record?.user_config_target_path || "") === targetPath);
      const planNeedsReview=plan?.status === "resolved-user-config" && plan?.requires_user_review === true;
      if (!planNeedsReview && !targetBackups.length) continue;
      const selected=plan.selected || null;
      const alternatives=[];
      for (const candidate of planNeedsReview ? (plan.backup_candidates || []) : []) {
        const sourcePath=normalizeStatePath(candidate?.source_path || "");
        const backup=records.find((record)=>record?.status === "verified-user-config-backup" && normalizeStatePath(record?.source_path || "") === sourcePath);
        alternatives.push({
          source_path:sourcePath || null,
          sha256:candidate?.sha256 || backup?.sha256 || null,
          backup_path:normalizeStatePath(backup?.target_path || "") || null,
        });
      }
      for (const backup of targetBackups) {
        if (alternatives.some((item)=>item.backup_path && normalizeStatePath(item.backup_path)===normalizeStatePath(backup.target_path || ""))) continue;
        alternatives.push({source_path:backup.source_path || null,sha256:backup.sha256 || null,backup_path:normalizeStatePath(backup.target_path || "") || null,origin:backup.origin || "target-existing"});
      }
      const signature=[targetPath,selected?.sha256 || "",...alternatives.map((item)=>`${item.source_path}:${item.sha256 || ""}`)].join("|");
      out.push({
        conflict_id:`config_${taskStableHash2983(signature)}`,
        kind:isUserManagedConfigTarget2984(targetPath) ? "classification-rules" : "user-config",
        status:"pending",
        detected_at:detectedAt,
        active_path:targetPath || null,
        active_source_path:normalizeStatePath(selected?.source_path || "") || null,
        active_sha256:selected?.sha256 || null,
        alternatives,
      });
    }
    return out;
  }

  function userConfigConflictCounts2984(manifest = {}) {
    const rows=Array.isArray(manifest?.conflicts) ? manifest.conflicts : [];
    return { pending:rows.filter((item)=>item?.status === "pending").length, total:rows.length, blocking:0 };
  }

  async function preflightManagedAssets2983(assets, io, resolutions = {}) {
    const list = Array.isArray(assets) ? assets : [];
    const grouped = new Map();
    for (const asset of list) {
      const sourcePath = String(asset?.source_path || "");
      const targetPath = String(asset?.target_path || sourcePath);
      if (!sourcePath || !targetPath) continue;
      if (!grouped.has(targetPath)) grouped.set(targetPath,[]);
      grouped.get(targetPath).push({ ...asset, source_path:sourcePath, target_path:targetPath });
    }
    const plans=[];
    let deduplicated=0, conflicts=0, missing=0;
    for (const [targetPath, candidatesRaw] of grouped.entries()) {
      if (candidatesRaw.length === 1) {
        plans.push({ target_path:targetPath, status:"ready", selected:candidatesRaw[0], candidates:candidatesRaw, duplicate_sources:[], resolution:null });
        continue;
      }
      const candidates=[];
      for (const candidate of candidatesRaw) {
        const bytes = await io.readSource(candidate.source_path);
        if (!bytes) { candidates.push({ ...candidate, missing:true, sha256:null }); continue; }
        candidates.push({ ...candidate, missing:false, sha256:await io.hashBytes(bytes) });
      }
      if (candidates.some((item)=>item.missing)) {
        missing += 1;
        plans.push({ target_path:targetPath, status:"missing-source", selected:null, candidates, duplicate_sources:[], resolution:null });
        continue;
      }
      const hashes=[...new Set(candidates.map((item)=>String(item.sha256 || "")))];
      const currentCandidate=candidates.find((item)=>item.source_path===targetPath) || null;
      if (hashes.length === 1) {
        const selected=currentCandidate || candidates[0];
        deduplicated += 1;
        plans.push({ target_path:targetPath, status:"ready", selected, candidates, duplicate_sources:candidates.filter((item)=>item.source_path!==selected.source_path), resolution:{decision:"deduplicated"} });
        continue;
      }
      const automaticPolicy=migrationConflictPolicy2984(targetPath,candidates);
      if (automaticPolicy.action === "preserve-active-user-config" && automaticPolicy.selected) {
        plans.push({
          target_path:targetPath, status:"resolved-user-config", selected:automaticPolicy.selected, candidates, duplicate_sources:[],
          backup_candidates:automaticPolicy.backups || [], requires_user_review:true,
          resolution:{decision:"preserve-active-user-config",source_path:automaticPolicy.selected.source_path},
        });
        continue;
      }
      if (automaticPolicy.action === "prefer-current-engineering" && automaticPolicy.selected) {
        plans.push({
          target_path:targetPath, status:"resolved-engineering", selected:automaticPolicy.selected, candidates,
          duplicate_sources:candidates.filter((item)=>item.source_path!==automaticPolicy.selected.source_path), requires_user_review:false,
          resolution:{decision:"prefer-current-engineering",source_path:automaticPolicy.selected.source_path},
        });
        continue;
      }
      const resolution = resolutions?.[targetPath] || null;
      let selected=null;
      let backups=[];
      if (resolution?.decision === "keep-current") selected=currentCandidate;
      else if (resolution?.decision === "keep-legacy") selected=candidates.find((item)=>item.source_path===String(resolution?.source_path || "")) || candidates.find((item)=>item.source_path!==targetPath) || null;
      else if (resolution?.decision === "keep-both") {
        selected=candidates.find((item)=>item.source_path===String(resolution?.source_path || "")) || currentCandidate || candidates[0] || null;
        backups=selected ? candidates.filter((item)=>item.source_path!==selected.source_path) : [];
      }
      if (selected) {
        plans.push({ target_path:targetPath, status:"resolved", selected, candidates, duplicate_sources:[], backup_candidates:backups, resolution:{...resolution,source_path:selected.source_path} });
      } else {
        conflicts += 1;
        plans.push({ target_path:targetPath, status:"conflict", selected:null, candidates, duplicate_sources:[], resolution:null });
      }
    }
    return { source_total:list.length, target_total:plans.length, total:plans.length, plans, deduplicated, conflicts, missing };
  }

  function migrationConflictBackupPath2983(taskRun, targetPath, candidate) {
    const taskId=taskSafeName2983(taskRun?.log?.task_id || `migration_${Date.now().toString(36)}`);
    const file=String(targetPath || "asset").split('/').pop() || 'asset';
    return `${ENGINEERING_ROOT}/迁移冲突保留/${taskId}/${taskStableHash2983(candidate?.source_path || candidate?.sha256 || file)}__${file}`;
  }

  function userConfigConflictBackupPath2984(taskRun, targetPath, candidate) {
    const taskId=taskSafeName2983(taskRun?.log?.task_id || `migration_${Date.now().toString(36)}`);
    const file=String(targetPath || "config.json").split('/').pop() || 'config.json';
    return `${USER_CONFIG_CONFLICT_ROOT_2984}/${taskId}/${taskStableHash2983(candidate?.source_path || candidate?.sha256 || file)}__${file}`;
  }

  async function copyManagedAssetManifest281(assets, io, { inPlace = false, progress = () => {}, resolutions = {}, taskRun = null } = {}) {
    const preflight = await preflightManagedAssets2983(assets,io,resolutions);
    let verified = 0, failed = 0, conflicts = 0;
    const records = [];
    for (let index = 0; index < preflight.plans.length; index++) {
      const plan = preflight.plans[index] || {};
      const targetPath = String(plan.target_path || "");
      progress({ phase:"copy", position:index + 1, total:preflight.plans.length, source_path:plan.selected?.source_path || null, target_path:targetPath });
      if (taskRun) {
        taskEvent2983(taskRun,{type:"migration_asset",stage:"copy",status:plan.status,position:index+1,total:preflight.plans.length,object_type:"asset",object_id:targetPath,name:targetPath,target_path:targetPath,source_path:plan.selected?.source_path || null});
        void writeTaskCheckpoint2983(taskRun,{phase:"migration-copy",position:index+1,total:preflight.plans.length,target_path:targetPath,resume_supported:true});
      }
      if (plan.status === "conflict") {
        conflicts += 1;
        const record={ target_path:targetPath, status:"conflict", conflict:true, candidates:plan.candidates.map(({source_path,sha256,asset_type})=>({source_path,sha256,asset_type})) };
        records.push(record);
        if (taskRun) taskEvent2983(taskRun,{type:"migration_conflict",stage:"preflight",status:"conflict",conflict:true,object_type:"asset",object_id:targetPath,target_path:targetPath,error_code:"duplicate_target_divergent_sources",candidates:record.candidates,next_action:"choose_migration_source"});
        continue;
      }
      if (plan.status === "missing-source" || !plan.selected) {
        failed += 1;
        const record={ target_path:targetPath, status:"missing-source", candidates:plan.candidates?.map(({source_path,sha256,missing})=>({source_path,sha256,missing})) || [] };
        records.push(record);
        if (taskRun) taskEvent2983(taskRun,{type:"migration_failure",stage:"preflight",status:"failed",object_type:"asset",object_id:targetPath,target_path:targetPath,error_code:"migration_source_missing"});
        continue;
      }
      const asset=plan.selected;
      const sourcePath=String(asset.source_path || "");
      try {
        const sourceBytes = await io.readSource(sourcePath);
        if (!sourceBytes) { failed++; records.push({ ...asset, target_path:targetPath, status:"missing-source" }); continue; }
        const sourceHash = asset.sha256 || await io.hashBytes(sourceBytes);
        if (inPlace && sourcePath === targetPath) {
          verified++;
          records.push({ ...asset, target_path:targetPath, sha256:sourceHash, status:plan.resolution?.decision === "deduplicated" ? "verified-deduplicated" : plan.status === "resolved-user-config" ? "verified-user-config-active" : plan.status === "resolved-engineering" ? "verified-engineering-current" : plan.status === "resolved" ? "verified-resolved" : "verified-in-place", resolution:plan.resolution || null, duplicate_sources:(plan.duplicate_sources || []).map((item)=>item.source_path) });
        } else {
          const existing = await io.readTarget(targetPath);
          if (existing) {
            const existingHash = await io.hashBytes(existing);
            if (existingHash !== sourceHash) {
              if (plan.status === "resolved-engineering") {
                await io.writeTarget(targetPath,sourceBytes);
              } else if (plan.status === "resolved-user-config" || isUserManagedConfigTarget2984(targetPath)) {
                const stagingCandidate={source_path:`${targetPath}#staging-existing`,sha256:existingHash};
                const backupPath=userConfigConflictBackupPath2984(taskRun,targetPath,stagingCandidate);
                const priorBackup=await io.readTarget(backupPath);
                if (!priorBackup) await io.writeTarget(backupPath,existing);
                const verifyBackup=await io.readTarget(backupPath);
                if (!verifyBackup || await io.hashBytes(verifyBackup)!==existingHash) { failed++; records.push({source_path:stagingCandidate.source_path,target_path:backupPath,status:"backup-verify-failed"}); continue; }
                records.push({source_path:stagingCandidate.source_path,target_path:backupPath,sha256:existingHash,status:"verified-user-config-backup",asset_type:"user-config-backup",user_config_target_path:targetPath,origin:"staging-existing"});
                await io.writeTarget(targetPath,sourceBytes);
              } else {
              const resolution=resolutions?.[targetPath] || null;
              if (resolution?.decision === "keep-current") {
                verified++;
                records.push({ ...asset, target_path:targetPath, source_path:sourcePath, sha256:existingHash, source_sha256:sourceHash, status:"verified-resolved-target", resolution, selected_origin:"target" });
                if (inPlace && sourcePath !== targetPath) await io.removeSource(sourcePath);
                continue;
              }
              if (resolution?.decision === "keep-both") {
                const backupPath=migrationConflictBackupPath2983(taskRun,targetPath,{source_path:sourcePath,sha256:sourceHash});
                const backupExisting=await io.readTarget(backupPath);
                if (!backupExisting) await io.writeTarget(backupPath,sourceBytes);
                const backupVerify=await io.readTarget(backupPath);
                if (!backupVerify || await io.hashBytes(backupVerify)!==sourceHash) { failed++; records.push({source_path:sourcePath,target_path:backupPath,status:"backup-verify-failed"}); continue; }
                verified++;
                records.push({ ...asset, target_path:targetPath, source_path:sourcePath, sha256:existingHash, source_sha256:sourceHash, status:"verified-resolved-both", resolution, selected_origin:"target", conflict_backup_path:backupPath });
                records.push({source_path:sourcePath,target_path:backupPath,sha256:sourceHash,status:"verified-conflict-backup",asset_type:asset.asset_type || "plugin-conflict-backup"});
                if (inPlace && sourcePath !== targetPath) await io.removeSource(sourcePath);
                continue;
              }
              if (resolution?.decision === "keep-legacy" && (!resolution?.source_path || String(resolution.source_path) === sourcePath)) {
                await io.writeTarget(targetPath,sourceBytes);
              } else {
                conflicts++;
                const candidates=[
                  {origin:"target",source_path:targetPath,sha256:existingHash,asset_type:"target-existing"},
                  {origin:"source",source_path:sourcePath,sha256:sourceHash,asset_type:asset.asset_type || "plugin"},
                ];
                const record={ ...asset, target_path:targetPath, sha256:sourceHash, existing_sha256:existingHash, status:"conflict-target-existing", conflict:true, resolution:null, candidates };
                records.push(record);
                if (taskRun) taskEvent2983(taskRun,{type:"migration_conflict",stage:"write",status:"conflict",conflict:true,object_type:"asset",object_id:targetPath,target_path:targetPath,source_path:sourcePath,error_code:"migration_target_content_conflict",expected_sha256:sourceHash,actual_sha256:existingHash,candidates,next_action:"choose_migration_source"});
                continue;
              }
              }
            }
          } else await io.writeTarget(targetPath, sourceBytes);
          const targetBytes = await io.readTarget(targetPath);
          if (!targetBytes || await io.hashBytes(targetBytes) !== sourceHash) {
            failed++;
            records.push({ ...asset, target_path:targetPath, sha256:sourceHash, status:"verify-failed" });
            if (taskRun) taskEvent2983(taskRun,{type:"migration_failure",stage:"verify",status:"failed",object_type:"asset",object_id:targetPath,target_path:targetPath,source_path:sourcePath,error_code:"migration_verify_failed"});
            continue;
          }
          verified++;
          records.push({ ...asset, target_path:targetPath, sha256:sourceHash, status:plan.resolution?.decision === "deduplicated" ? "verified-deduplicated" : plan.status === "resolved-user-config" ? "verified-user-config-active" : plan.status === "resolved-engineering" ? "verified-engineering-current" : plan.status === "resolved" ? "verified-resolved" : "verified", resolution:plan.resolution || null, duplicate_sources:(plan.duplicate_sources || []).map((item)=>item.source_path) });
        }

        if (["keep-both","preserve-active-user-config"].includes(plan.resolution?.decision)) {
          for (const candidate of plan.backup_candidates || []) {
            const backupBytes=await io.readSource(candidate.source_path);
            if (!backupBytes) { failed++; records.push({source_path:candidate.source_path,target_path:targetPath,status:"backup-missing-source"}); continue; }
            const userConfig=plan.resolution?.decision === "preserve-active-user-config";
            const backupPath=userConfig ? userConfigConflictBackupPath2984(taskRun,targetPath,candidate) : migrationConflictBackupPath2983(taskRun,targetPath,candidate);
            const backupHash=candidate.sha256 || await io.hashBytes(backupBytes);
            const backupExisting=await io.readTarget(backupPath);
            if (!backupExisting) await io.writeTarget(backupPath,backupBytes);
            const verifyBackup=await io.readTarget(backupPath);
            if (!verifyBackup || await io.hashBytes(verifyBackup)!==backupHash) { failed++; records.push({source_path:candidate.source_path,target_path:backupPath,status:"backup-verify-failed"}); continue; }
            records.push({source_path:candidate.source_path,target_path:backupPath,sha256:backupHash,status:userConfig ? "verified-user-config-backup" : "verified-conflict-backup",asset_type:userConfig ? "user-config-backup" : (candidate.asset_type || "plugin-conflict-backup")});
          }
        }

        if (inPlace) {
          const removable=[...(plan.duplicate_sources || []),...(plan.status === "resolved" ? (plan.candidates || []).filter((item)=>item.source_path!==sourcePath) : [])];
          const seen=new Set();
          for (const candidate of removable) {
            const path=String(candidate?.source_path || "");
            if (!path || path===targetPath || seen.has(path)) continue;
            seen.add(path);
            await io.removeSource(path);
          }
          if (sourcePath !== targetPath) await io.removeSource(sourcePath);
        }
      } catch (error) {
        failed++;
        records.push({ ...asset, target_path:targetPath, status:"failed", reason:error?.message || String(error), error_code:error?.code || error?.name || "migration_copy_failed" });
        if (taskRun) taskEvent2983(taskRun,{type:"migration_failure",stage:"copy",status:"failed",object_type:"asset",object_id:targetPath,target_path:targetPath,source_path:sourcePath,error_code:error?.code || error?.name || "migration_copy_failed",message:error?.message || String(error)});
      }
    }
    const result = { total:preflight.plans.length, source_total:preflight.source_total, verified, failed, conflicts, deduplicated:preflight.deduplicated, records, preflight };
    result.complete = verified === preflight.plans.length && failed === 0 && conflicts === 0;
    return result;
  }

  function libraryLayout299() {
    return {
      raw:RAW_ROOT, json:JSON_ROOT, markdown:MARKDOWN_ROOT, pdf:PDF_ROOT,
      projects:PROJECT_ROOT, archived:SYSTEM_ARCHIVE_FOLDER, deleted:SYSTEM_DELETED_FOLDER, engineering:ENGINEERING_ROOT,
      history:EXTRACTION_HISTORY_FOLDER, meta:META_DIR, publicIndex:PUBLIC_INDEX_PATH, timeline:TIMELINE_PATH,
    };
  }

  function mapLegacyLibraryPath299(value) {
    const path = String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!path) return "";
    const currentRoots = [RAW_ROOT, JSON_ROOT, MARKDOWN_ROOT, PDF_ROOT, PROJECT_ROOT, SYSTEM_ARCHIVE_FOLDER, SYSTEM_DELETED_FOLDER, ENGINEERING_ROOT];
    if (currentRoots.some((root) => path === root || path.startsWith(`${root}/`))) return path;
    if (path === "conversation-index.json") return PUBLIC_INDEX_PATH;
    if (path === "timeline.json") return TIMELINE_PATH;
    if (path === "提取历史" || path.startsWith("提取历史/")) return joinPath(EXTRACTION_HISTORY_FOLDER, path.slice("提取历史".length));
    if (path === LEGACY_META_DIR || path.startsWith(`${LEGACY_META_DIR}/`)) return joinPath(META_DIR, path.slice(LEGACY_META_DIR.length));
    const rootMap = new Map([["原始",RAW_ROOT],["JSON",JSON_ROOT],["Markdown",MARKDOWN_ROOT],["PDF",PDF_ROOT]]);
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "项目" && parts.length >= 2) {
      const projectName = parts[1];
      const format = rootMap.get(parts[2]) || parts[2];
      return joinPath(PROJECT_ROOT, projectName, format, ...parts.slice(3));
    }
    const stateRoot = parts[0] === "归档" || parts[0] === LEGACY_ARCHIVE_FOLDER ? SYSTEM_ARCHIVE_FOLDER
      : parts[0] === "已删除" || parts[0] === LEGACY_DELETED_FOLDER ? SYSTEM_DELETED_FOLDER : "";
    if (stateRoot) {
      if (parts[1] === "项目" && parts.length >= 4) {
        const projectName = parts[2];
        const format = rootMap.get(parts[3]) || parts[3];
        return joinPath(stateRoot, PROJECT_ROOT, projectName, format, ...parts.slice(4));
      }
      const format = rootMap.get(parts[1]) || parts[1];
      return joinPath(stateRoot, format, ...parts.slice(2));
    }
    if (rootMap.has(parts[0])) return joinPath(rootMap.get(parts[0]), ...parts.slice(1));
    return path;
  }
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
    const root = kind === "json" ? `${JSON_ROOT}/` : `${MARKDOWN_ROOT}/`;
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
      // 分类目标不一致属于可自动整理事项：同步时按用户现有规则/覆盖项更新位置，不要求用户确认。
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
      json: joinPath(JSON_ROOT, subdir, `${stem}.json`),
      markdown: joinPath(MARKDOWN_ROOT, subdir, `${stem}.md`),
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
      project_memberships: Array.isArray(inventoryItem?.project_memberships) ? inventoryItem.project_memberships.map((item) => ({ id: String(item?.id || ""), name: String(item?.name || "未命名项目") })).filter((item) => item.id || item.name) : [],
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

  function extractionStateFromEntry(entry = {}) {
    const value = String(entry.state || entry.local_state || entry.source_state || "active").trim().toLowerCase();
    return ["active", "archived", "deleted"].includes(value) ? value : "active";
  }

  function extractionProjectMemberships(entry = {}) {
    const source = Array.isArray(entry.project_memberships) ? entry.project_memberships : [];
    const memberships = source.map((item) => ({
      id: String(item?.id || item?.project_id || "").trim(),
      name: String(item?.name || item?.project_name || "未命名项目").trim() || "未命名项目",
    })).filter((item) => item.id || item.name);
    if (!memberships.length && (entry.project_id || entry.project_name)) {
      memberships.push({ id:String(entry.project_id || "").trim(), name:String(entry.project_name || "未命名项目").trim() || "未命名项目" });
    }
    return memberships;
  }

  function extractionProjectKey(project = {}) {
    const id = String(project?.id || "").trim();
    if (id) return id;
    const name = String(project?.name || "").trim();
    return name ? `name:${name}` : "";
  }

  function normalizeExtractionSourceMode(value) {
    return String(value || "").trim().toLowerCase() === "project" ? "project" : "chatgpt";
  }

  function extractionProjectViewMemberships(entry = {}) {
    const byKey = new Map();
    for (const view of Array.isArray(entry?.project_views) ? entry.project_views : []) {
      const project = { id:String(view?.project_id || "").trim(), name:String(view?.project_name || "未命名项目").trim() || "未命名项目" };
      const key = extractionProjectKey(project);
      if (key && !byKey.has(key)) byKey.set(key, project);
    }
    if (!byKey.size) for (const project of extractionProjectMemberships(entry)) {
      const key = extractionProjectKey(project);
      if (key && !byKey.has(key)) byKey.set(key, project);
    }
    return [...byKey.values()];
  }

  function extractionPathsForSource(entry = {}, options = {}) {
    const root = {
      raw:normalizeStatePath(entry?.raw_path || rawPathForIndexEntry295(entry)),
      json:normalizeStatePath(entry?.json_path || ""),
      markdown:normalizeStatePath(entry?.markdown_path || ""),
      pdf:normalizeStatePath(entry?.pdf_path || pdfPathForMarkdown295(entry?.markdown_path || "")),
      source:"chatgpt", project:null,
    };
    if (normalizeExtractionSourceMode(options?.source) !== "project") return root;
    const memberships = extractionProjectViewMemberships(entry);
    const requested = String(options?.project || "").trim();
    const selected = memberships.find((project) => extractionProjectKey(project) === requested) || memberships[0] || null;
    if (!selected) return { raw:"",json:"",markdown:"",pdf:"",source:"project",project:null };
    const key = extractionProjectKey(selected);
    const views = (Array.isArray(entry?.project_views) ? entry.project_views : []).filter((view) => extractionProjectKey({id:view?.project_id,name:view?.project_name}) === key);
    const byKind = new Map(views.map((view) => [String(view?.kind || ""), normalizeStatePath(view?.path || "")]));
    if (!views.length) {
      const planned = V295.planPersistentViews({ conversation_id:entry?.conversation_id, title:entry?.title, classification:entry?.classification, project_memberships:[selected] })
        .filter((view) => view.view === "project");
      for (const view of planned) byKind.set(view.kind, view.path);
    }
    return { raw:byKind.get("raw") || "", json:byKind.get("json") || "", markdown:byKind.get("markdown") || "", pdf:byKind.get("pdf") || "", source:"project", project:selected };
  }

  function extractionSearchText(entry = {}, sourceMode = "chatgpt") {
    const projects = normalizeExtractionSourceMode(sourceMode) === "project"
      ? extractionProjectViewMemberships(entry).flatMap((item) => [item.id, item.name]) : [];
    return [entry.title, entry.conversation_id, extractionFieldFromEntry(entry), extractionFolderFromEntry(entry), ...projects]
      .map((value) => String(value || "").trim()).join("\n").toLowerCase();
  }

  function buildExtractionCatalogEntries(index = {}, conversationState = {}) {
    const stateMap = conversationState?.conversations && typeof conversationState.conversations === "object" ? conversationState.conversations : {};
    return Object.values(index?.conversations && typeof index.conversations === "object" ? index.conversations : index || {})
      .filter((entry) => entry?.conversation_id)
      .map((entry) => ({ ...entry, state: extractionStateFromEntry({ ...entry, state:stateMap[String(entry.conversation_id)]?.state || entry.state }) }))
      .filter((entry) => entry.state !== "deleted");
  }

  function normalizeExtractionOptions(options = {}) {
    const days = Number(options.days || 0);
    const state = String(options.state || "active").trim().toLowerCase();
    return {
      source: normalizeExtractionSourceMode(options.source),
      state: ["active", "archived", "all"].includes(state) ? state : "active",
      project: String(options.project || "").trim(),
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
    const raw = Array.isArray(indexOrEntries)
      ? indexOrEntries
      : Object.values(indexOrEntries?.conversations && typeof indexOrEntries.conversations === "object" ? indexOrEntries.conversations : indexOrEntries || {});
    const byId = new Map();
    for (const entry of raw) {
      const id = String(entry?.conversation_id || "");
      if (!id) continue;
      const previous = byId.get(id);
      if (!previous || toTimestampMs(entry.update_time || entry.create_time) >= toTimestampMs(previous.update_time || previous.create_time)) byId.set(id, entry);
    }
    const source = [...byId.values()];
    const startMs = normalized.start ? Date.parse(`${normalized.start}T00:00:00`) : 0;
    const endMs = normalized.end ? Date.parse(`${normalized.end}T23:59:59.999`) : 0;
    const cutoff = normalized.days ? now - normalized.days * DAY_MS : 0;
    return source.filter((entry) => {
      const state = extractionStateFromEntry(entry);
      if (state === "deleted") return false;
      if (normalized.state !== "all" && state !== normalized.state) return false;
      const projectMemberships = extractionProjectViewMemberships(entry);
      if (normalized.source === "project" && !projectMemberships.length) return false;
      if (normalized.source === "project" && normalized.project) {
        const matchesProject = projectMemberships.some((item) => extractionProjectKey(item) === normalized.project);
        if (!matchesProject) return false;
      }
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
      if (normalized.keyword && !extractionSearchText(entry, normalized.source).includes(normalized.keyword)) return false;
      return true;
    }).sort((a, b) => toTimestampMs(b.update_time || b.create_time) - toTimestampMs(a.update_time || a.create_time)
      || String(a.title || "").localeCompare(String(b.title || "")));
  }

  function reconcileExtractionSelection(selectedIds, catalogEntries = []) {
    const available = new Set((catalogEntries || []).map((entry) => String(entry?.conversation_id || "")).filter(Boolean));
    return new Set([...(selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []))].map(String).filter((id) => available.has(id)));
  }

  function selectedExtractionEntriesFromCatalog(catalogEntries = [], selectedIds = new Set()) {
    const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
    return (catalogEntries || []).filter((entry) => selected.has(String(entry?.conversation_id || "")));
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


  /* AI_CHAT_FLOW_KATEX_0_16_27_BEGIN */
  // KaTeX 0.16.27 (MIT) vendored for offline PDF math parsing.
  // Source asset is the local Gradio frontend bundle; PDF uses KaTeX -> MathML -> browser rasterization.
  const AIChatFlowKaTeX=(()=>{class o0{constructor(e,t,a){this.lexer=void 0,this.start=void 0,this.end=void 0,this.lexer=e,this.start=t,this.end=a}static range(e,t){return t?!e||!e.loc||!t.loc||e.loc.lexer!==t.loc.lexer?null:new o0(e.loc.lexer,e.loc.start,t.loc.end):e&&e.loc}}class u0{constructor(e,t){this.text=void 0,this.loc=void 0,this.noexpand=void 0,this.treatAsRelax=void 0,this.text=e,this.loc=t}range(e,t){return new u0(t,o0.range(this,e))}}class M{constructor(e,t){this.name=void 0,this.position=void 0,this.length=void 0,this.rawMessage=void 0;var a="KaTeX parse error: "+e,i,s,o=t&&t.loc;if(o&&o.start<=o.end){var m=o.lexer.input;i=o.start,s=o.end,i===m.length?a+=" at end of input: ":a+=" at position "+(i+1)+": ";var c=m.slice(i,s).replace(/[^]/g,"$&̲"),p;i>15?p="…"+m.slice(i-15,i):p=m.slice(0,i);var g;s+15<m.length?g=m.slice(s,s+15)+"…":g=m.slice(s),a+=p+c+g}var y=new Error(a);return y.name="ParseError",y.__proto__=M.prototype,y.position=i,i!=null&&s!=null&&(y.length=s-i),y.rawMessage=e,y}}M.prototype.__proto__=Error.prototype;var fa=function(e,t){return e===void 0?t:e},pa=/([A-Z])/g,va=function(e){return e.replace(pa,"-$1").toLowerCase()},ga={"&":"&amp;",">":"&gt;","<":"&lt;",'"':"&quot;","'":"&#x27;"},ba=/[&><"']/g;function ya(r){return String(r).replace(ba,e=>ga[e])}var vr=function r(e){return e.type==="ordgroup"||e.type==="color"?e.body.length===1?r(e.body[0]):e:e.type==="font"?r(e.body):e},wa=function(e){var t=vr(e);return t.type==="mathord"||t.type==="textord"||t.type==="atom"},xa=function(e){if(!e)throw new Error("Expected non-null, but got "+String(e));return e},ka=function(e){var t=/^[\x00-\x20]*([^\\/#?]*?)(:|&#0*58|&#x0*3a|&colon)/i.exec(e);return t?t[2]!==":"||!/^[a-zA-Z][a-zA-Z0-9+\-.]*$/.test(t[1])?null:t[1].toLowerCase():"_relative"},V={deflt:fa,escape:ya,hyphenate:va,getBaseElem:vr,isCharacterBox:wa,protocolFromUrl:ka},ze={displayMode:{type:"boolean",description:"Render math in display mode, which puts the math in display style (so \\int and \\sum are large, for example), and centers the math on the page on its own line.",cli:"-d, --display-mode"},output:{type:{enum:["htmlAndMathml","html","mathml"]},description:"Determines the markup language of the output.",cli:"-F, --format <type>"},leqno:{type:"boolean",description:"Render display math in leqno style (left-justified tags)."},fleqn:{type:"boolean",description:"Render display math flush left."},throwOnError:{type:"boolean",default:!0,cli:"-t, --no-throw-on-error",cliDescription:"Render errors (in the color given by --error-color) instead of throwing a ParseError exception when encountering an error."},errorColor:{type:"string",default:"#cc0000",cli:"-c, --error-color <color>",cliDescription:"A color string given in the format 'rgb' or 'rrggbb' (no #). This option determines the color of errors rendered by the -t option.",cliProcessor:r=>"#"+r},macros:{type:"object",cli:"-m, --macro <def>",cliDescription:"Define custom macro of the form '\\foo:expansion' (use multiple -m arguments for multiple macros).",cliDefault:[],cliProcessor:(r,e)=>(e.push(r),e)},minRuleThickness:{type:"number",description:"Specifies a minimum thickness, in ems, for fraction lines, `\\sqrt` top lines, `{array}` vertical lines, `\\hline`, `\\hdashline`, `\\underline`, `\\overline`, and the borders of `\\fbox`, `\\boxed`, and `\\fcolorbox`.",processor:r=>Math.max(0,r),cli:"--min-rule-thickness <size>",cliProcessor:parseFloat},colorIsTextColor:{type:"boolean",description:"Makes \\color behave like LaTeX's 2-argument \\textcolor, instead of LaTeX's one-argument \\color mode change.",cli:"-b, --color-is-text-color"},strict:{type:[{enum:["warn","ignore","error"]},"boolean","function"],description:"Turn on strict / LaTeX faithfulness mode, which throws an error if the input uses features that are not supported by LaTeX.",cli:"-S, --strict",cliDefault:!1},trust:{type:["boolean","function"],description:"Trust the input, enabling all HTML features such as \\url.",cli:"-T, --trust"},maxSize:{type:"number",default:1/0,description:"If non-zero, all user-specified sizes, e.g. in \\rule{500em}{500em}, will be capped to maxSize ems. Otherwise, elements and spaces can be arbitrarily large",processor:r=>Math.max(0,r),cli:"-s, --max-size <n>",cliProcessor:parseInt},maxExpand:{type:"number",default:1e3,description:"Limit the number of macro expansions to the specified number, to prevent e.g. infinite macro loops. If set to Infinity, the macro expander will try to fully expand as in LaTeX.",processor:r=>Math.max(0,r),cli:"-e, --max-expand <n>",cliProcessor:r=>r==="Infinity"?1/0:parseInt(r)},globalGroup:{type:"boolean",cli:!1}};function Sa(r){if(r.default)return r.default;var e=r.type,t=Array.isArray(e)?e[0]:e;if(typeof t!="string")return t.enum[0];switch(t){case"boolean":return!1;case"string":return"";case"number":return 0;case"object":return{}}}class dt{constructor(e){this.displayMode=void 0,this.output=void 0,this.leqno=void 0,this.fleqn=void 0,this.throwOnError=void 0,this.errorColor=void 0,this.macros=void 0,this.minRuleThickness=void 0,this.colorIsTextColor=void 0,this.strict=void 0,this.trust=void 0,this.maxSize=void 0,this.maxExpand=void 0,this.globalGroup=void 0,e=e||{};for(var t in ze)if(ze.hasOwnProperty(t)){var a=ze[t];this[t]=e[t]!==void 0?a.processor?a.processor(e[t]):e[t]:Sa(a)}}reportNonstrict(e,t,a){var i=this.strict;if(typeof i=="function"&&(i=i(e,t,a)),!(!i||i==="ignore")){if(i===!0||i==="error")throw new M("LaTeX-incompatible input and strict mode is set to 'error': "+(t+" ["+e+"]"),a);i==="warn"?typeof console<"u"&&console.warn("LaTeX-incompatible input and strict mode is set to 'warn': "+(t+" ["+e+"]")):typeof console<"u"&&console.warn("LaTeX-incompatible input and strict mode is set to "+("unrecognized '"+i+"': "+t+" ["+e+"]"))}}useStrictBehavior(e,t,a){var i=this.strict;if(typeof i=="function")try{i=i(e,t,a)}catch{i="error"}return!i||i==="ignore"?!1:i===!0||i==="error"?!0:i==="warn"?(typeof console<"u"&&console.warn("LaTeX-incompatible input and strict mode is set to 'warn': "+(t+" ["+e+"]")),!1):(typeof console<"u"&&console.warn("LaTeX-incompatible input and strict mode is set to "+("unrecognized '"+i+"': "+t+" ["+e+"]")),!1)}isTrusted(e){if(e.url&&!e.protocol){var t=V.protocolFromUrl(e.url);if(t==null)return!1;e.protocol=t}var a=typeof this.trust=="function"?this.trust(e):this.trust;return!!a}}class H0{constructor(e,t,a){this.id=void 0,this.size=void 0,this.cramped=void 0,this.id=e,this.size=t,this.cramped=a}sup(){return y0[Ma[this.id]]}sub(){return y0[za[this.id]]}fracNum(){return y0[Ta[this.id]]}fracDen(){return y0[Aa[this.id]]}cramp(){return y0[Ba[this.id]]}text(){return y0[Na[this.id]]}isTight(){return this.size>=2}}var ft=0,Ae=1,ee=2,B0=3,le=4,f0=5,te=6,i0=7,y0=[new H0(ft,0,!1),new H0(Ae,0,!0),new H0(ee,1,!1),new H0(B0,1,!0),new H0(le,2,!1),new H0(f0,2,!0),new H0(te,3,!1),new H0(i0,3,!0)],Ma=[le,f0,le,f0,te,i0,te,i0],za=[f0,f0,f0,f0,i0,i0,i0,i0],Ta=[ee,B0,le,f0,te,i0,te,i0],Aa=[B0,B0,f0,f0,i0,i0,i0,i0],Ba=[Ae,Ae,B0,B0,f0,f0,i0,i0],Na=[ft,Ae,ee,B0,ee,B0,ee,B0],I={DISPLAY:y0[ft],TEXT:y0[ee],SCRIPT:y0[le],SCRIPTSCRIPT:y0[te]},it=[{name:"latin",blocks:[[256,591],[768,879]]},{name:"cyrillic",blocks:[[1024,1279]]},{name:"armenian",blocks:[[1328,1423]]},{name:"brahmic",blocks:[[2304,4255]]},{name:"georgian",blocks:[[4256,4351]]},{name:"cjk",blocks:[[12288,12543],[19968,40879],[65280,65376]]},{name:"hangul",blocks:[[44032,55215]]}];function Ca(r){for(var e=0;e<it.length;e++)for(var t=it[e],a=0;a<t.blocks.length;a++){var i=t.blocks[a];if(r>=i[0]&&r<=i[1])return t.name}return null}var Te=[];it.forEach(r=>r.blocks.forEach(e=>Te.push(...e)));function gr(r){for(var e=0;e<Te.length;e+=2)if(r>=Te[e]&&r<=Te[e+1])return!0;return!1}var _0=80,qa=function(e,t){return"M95,"+(622+e+t)+`
c-2.7,0,-7.17,-2.7,-13.5,-8c-5.8,-5.3,-9.5,-10,-9.5,-14
c0,-2,0.3,-3.3,1,-4c1.3,-2.7,23.83,-20.7,67.5,-54
c44.2,-33.3,65.8,-50.3,66.5,-51c1.3,-1.3,3,-2,5,-2c4.7,0,8.7,3.3,12,10
s173,378,173,378c0.7,0,35.3,-71,104,-213c68.7,-142,137.5,-285,206.5,-429
c69,-144,104.5,-217.7,106.5,-221
l`+e/2.075+" -"+e+`
c5.3,-9.3,12,-14,20,-14
H400000v`+(40+e)+`H845.2724
s-225.272,467,-225.272,467s-235,486,-235,486c-2.7,4.7,-9,7,-19,7
c-6,0,-10,-1,-12,-3s-194,-422,-194,-422s-65,47,-65,47z
M`+(834+e)+" "+t+"h400000v"+(40+e)+"h-400000z"},Ra=function(e,t){return"M263,"+(601+e+t)+`c0.7,0,18,39.7,52,119
c34,79.3,68.167,158.7,102.5,238c34.3,79.3,51.8,119.3,52.5,120
c340,-704.7,510.7,-1060.3,512,-1067
l`+e/2.084+" -"+e+`
c4.7,-7.3,11,-11,19,-11
H40000v`+(40+e)+`H1012.3
s-271.3,567,-271.3,567c-38.7,80.7,-84,175,-136,283c-52,108,-89.167,185.3,-111.5,232
c-22.3,46.7,-33.8,70.3,-34.5,71c-4.7,4.7,-12.3,7,-23,7s-12,-1,-12,-1
s-109,-253,-109,-253c-72.7,-168,-109.3,-252,-110,-252c-10.7,8,-22,16.7,-34,26
c-22,17.3,-33.3,26,-34,26s-26,-26,-26,-26s76,-59,76,-59s76,-60,76,-60z
M`+(1001+e)+" "+t+"h400000v"+(40+e)+"h-400000z"},Ia=function(e,t){return"M983 "+(10+e+t)+`
l`+e/3.13+" -"+e+`
c4,-6.7,10,-10,18,-10 H400000v`+(40+e)+`
H1013.1s-83.4,268,-264.1,840c-180.7,572,-277,876.3,-289,913c-4.7,4.7,-12.7,7,-24,7
s-12,0,-12,0c-1.3,-3.3,-3.7,-11.7,-7,-25c-35.3,-125.3,-106.7,-373.3,-214,-744
c-10,12,-21,25,-33,39s-32,39,-32,39c-6,-5.3,-15,-14,-27,-26s25,-30,25,-30
c26.7,-32.7,52,-63,76,-91s52,-60,52,-60s208,722,208,722
c56,-175.3,126.3,-397.3,211,-666c84.7,-268.7,153.8,-488.2,207.5,-658.5
c53.7,-170.3,84.5,-266.8,92.5,-289.5z
M`+(1001+e)+" "+t+"h400000v"+(40+e)+"h-400000z"},Da=function(e,t){return"M424,"+(2398+e+t)+`
c-1.3,-0.7,-38.5,-172,-111.5,-514c-73,-342,-109.8,-513.3,-110.5,-514
c0,-2,-10.7,14.3,-32,49c-4.7,7.3,-9.8,15.7,-15.5,25c-5.7,9.3,-9.8,16,-12.5,20
s-5,7,-5,7c-4,-3.3,-8.3,-7.7,-13,-13s-13,-13,-13,-13s76,-122,76,-122s77,-121,77,-121
s209,968,209,968c0,-2,84.7,-361.7,254,-1079c169.3,-717.3,254.7,-1077.7,256,-1081
l`+e/4.223+" -"+e+`c4,-6.7,10,-10,18,-10 H400000
v`+(40+e)+`H1014.6
s-87.3,378.7,-272.6,1166c-185.3,787.3,-279.3,1182.3,-282,1185
c-2,6,-10,9,-24,9
c-8,0,-12,-0.7,-12,-2z M`+(1001+e)+" "+t+`
h400000v`+(40+e)+"h-400000z"},Ea=function(e,t){return"M473,"+(2713+e+t)+`
c339.3,-1799.3,509.3,-2700,510,-2702 l`+e/5.298+" -"+e+`
c3.3,-7.3,9.3,-11,18,-11 H400000v`+(40+e)+`H1017.7
s-90.5,478,-276.2,1466c-185.7,988,-279.5,1483,-281.5,1485c-2,6,-10,9,-24,9
c-8,0,-12,-0.7,-12,-2c0,-1.3,-5.3,-32,-16,-92c-50.7,-293.3,-119.7,-693.3,-207,-1200
c0,-1.3,-5.3,8.7,-16,30c-10.7,21.3,-21.3,42.7,-32,64s-16,33,-16,33s-26,-26,-26,-26
s76,-153,76,-153s77,-151,77,-151c0.7,0.7,35.7,202,105,604c67.3,400.7,102,602.7,104,
606zM`+(1001+e)+" "+t+"h400000v"+(40+e)+"H1017.7z"},Oa=function(e){var t=e/2;return"M400000 "+e+" H0 L"+t+" 0 l65 45 L145 "+(e-80)+" H400000z"},Ha=function(e,t,a){var i=a-54-t-e;return"M702 "+(e+t)+"H400000"+(40+e)+`
H742v`+i+`l-4 4-4 4c-.667.7 -2 1.5-4 2.5s-4.167 1.833-6.5 2.5-5.5 1-9.5 1
h-12l-28-84c-16.667-52-96.667 -294.333-240-727l-212 -643 -85 170
c-4-3.333-8.333-7.667-13 -13l-13-13l77-155 77-156c66 199.333 139 419.667
219 661 l218 661zM702 `+t+"H400000v"+(40+e)+"H742z"},La=function(e,t,a){t=1e3*t;var i="";switch(e){case"sqrtMain":i=qa(t,_0);break;case"sqrtSize1":i=Ra(t,_0);break;case"sqrtSize2":i=Ia(t,_0);break;case"sqrtSize3":i=Da(t,_0);break;case"sqrtSize4":i=Ea(t,_0);break;case"sqrtTall":i=Ha(t,_0,a)}return i},Fa=function(e,t){switch(e){case"⎜":return"M291 0 H417 V"+t+" H291z M291 0 H417 V"+t+" H291z";case"∣":return"M145 0 H188 V"+t+" H145z M145 0 H188 V"+t+" H145z";case"∥":return"M145 0 H188 V"+t+" H145z M145 0 H188 V"+t+" H145z"+("M367 0 H410 V"+t+" H367z M367 0 H410 V"+t+" H367z");case"⎟":return"M457 0 H583 V"+t+" H457z M457 0 H583 V"+t+" H457z";case"⎢":return"M319 0 H403 V"+t+" H319z M319 0 H403 V"+t+" H319z";case"⎥":return"M263 0 H347 V"+t+" H263z M263 0 H347 V"+t+" H263z";case"⎪":return"M384 0 H504 V"+t+" H384z M384 0 H504 V"+t+" H384z";case"⏐":return"M312 0 H355 V"+t+" H312z M312 0 H355 V"+t+" H312z";case"‖":return"M257 0 H300 V"+t+" H257z M257 0 H300 V"+t+" H257z"+("M478 0 H521 V"+t+" H478z M478 0 H521 V"+t+" H478z");default:return""}},Ot={doubleleftarrow:`M262 157
l10-10c34-36 62.7-77 86-123 3.3-8 5-13.3 5-16 0-5.3-6.7-8-20-8-7.3
 0-12.2.5-14.5 1.5-2.3 1-4.8 4.5-7.5 10.5-49.3 97.3-121.7 169.3-217 216-28
 14-57.3 25-88 33-6.7 2-11 3.8-13 5.5-2 1.7-3 4.2-3 7.5s1 5.8 3 7.5
c2 1.7 6.3 3.5 13 5.5 68 17.3 128.2 47.8 180.5 91.5 52.3 43.7 93.8 96.2 124.5
 157.5 9.3 8 15.3 12.3 18 13h6c12-.7 18-4 18-10 0-2-1.7-7-5-15-23.3-46-52-87
-86-123l-10-10h399738v-40H218c328 0 0 0 0 0l-10-8c-26.7-20-65.7-43-117-69 2.7
-2 6-3.7 10-5 36.7-16 72.3-37.3 107-64l10-8h399782v-40z
m8 0v40h399730v-40zm0 194v40h399730v-40z`,doublerightarrow:`M399738 392l
-10 10c-34 36-62.7 77-86 123-3.3 8-5 13.3-5 16 0 5.3 6.7 8 20 8 7.3 0 12.2-.5
 14.5-1.5 2.3-1 4.8-4.5 7.5-10.5 49.3-97.3 121.7-169.3 217-216 28-14 57.3-25 88
-33 6.7-2 11-3.8 13-5.5 2-1.7 3-4.2 3-7.5s-1-5.8-3-7.5c-2-1.7-6.3-3.5-13-5.5-68
-17.3-128.2-47.8-180.5-91.5-52.3-43.7-93.8-96.2-124.5-157.5-9.3-8-15.3-12.3-18
-13h-6c-12 .7-18 4-18 10 0 2 1.7 7 5 15 23.3 46 52 87 86 123l10 10H0v40h399782
c-328 0 0 0 0 0l10 8c26.7 20 65.7 43 117 69-2.7 2-6 3.7-10 5-36.7 16-72.3 37.3
-107 64l-10 8H0v40zM0 157v40h399730v-40zm0 194v40h399730v-40z`,leftarrow:`M400000 241H110l3-3c68.7-52.7 113.7-120
 135-202 4-14.7 6-23 6-25 0-7.3-7-11-21-11-8 0-13.2.8-15.5 2.5-2.3 1.7-4.2 5.8
-5.5 12.5-1.3 4.7-2.7 10.3-4 17-12 48.7-34.8 92-68.5 130S65.3 228.3 18 247
c-10 4-16 7.7-18 11 0 8.7 6 14.3 18 17 47.3 18.7 87.8 47 121.5 85S196 441.3 208
 490c.7 2 1.3 5 2 9s1.2 6.7 1.5 8c.3 1.3 1 3.3 2 6s2.2 4.5 3.5 5.5c1.3 1 3.3
 1.8 6 2.5s6 1 10 1c14 0 21-3.7 21-11 0-2-2-10.3-6-25-20-79.3-65-146.7-135-202
 l-3-3h399890zM100 241v40h399900v-40z`,leftbrace:`M6 548l-6-6v-35l6-11c56-104 135.3-181.3 238-232 57.3-28.7 117
-45 179-50h399577v120H403c-43.3 7-81 15-113 26-100.7 33-179.7 91-237 174-2.7
 5-6 9-10 13-.7 1-7.3 1-20 1H6z`,leftbraceunder:`M0 6l6-6h17c12.688 0 19.313.3 20 1 4 4 7.313 8.3 10 13
 35.313 51.3 80.813 93.8 136.5 127.5 55.688 33.7 117.188 55.8 184.5 66.5.688
 0 2 .3 4 1 18.688 2.7 76 4.3 172 5h399450v120H429l-6-1c-124.688-8-235-61.7
-331-161C60.687 138.7 32.312 99.3 7 54L0 41V6z`,leftgroup:`M400000 80
H435C64 80 168.3 229.4 21 260c-5.9 1.2-18 0-18 0-2 0-3-1-3-3v-38C76 61 257 0
 435 0h399565z`,leftgroupunder:`M400000 262
H435C64 262 168.3 112.6 21 82c-5.9-1.2-18 0-18 0-2 0-3 1-3 3v38c76 158 257 219
 435 219h399565z`,leftharpoon:`M0 267c.7 5.3 3 10 7 14h399993v-40H93c3.3
-3.3 10.2-9.5 20.5-18.5s17.8-15.8 22.5-20.5c50.7-52 88-110.3 112-175 4-11.3 5
-18.3 3-21-1.3-4-7.3-6-18-6-8 0-13 .7-15 2s-4.7 6.7-8 16c-42 98.7-107.3 174.7
-196 228-6.7 4.7-10.7 8-12 10-1.3 2-2 5.7-2 11zm100-26v40h399900v-40z`,leftharpoonplus:`M0 267c.7 5.3 3 10 7 14h399993v-40H93c3.3-3.3 10.2-9.5
 20.5-18.5s17.8-15.8 22.5-20.5c50.7-52 88-110.3 112-175 4-11.3 5-18.3 3-21-1.3
-4-7.3-6-18-6-8 0-13 .7-15 2s-4.7 6.7-8 16c-42 98.7-107.3 174.7-196 228-6.7 4.7
-10.7 8-12 10-1.3 2-2 5.7-2 11zm100-26v40h399900v-40zM0 435v40h400000v-40z
m0 0v40h400000v-40z`,leftharpoondown:`M7 241c-4 4-6.333 8.667-7 14 0 5.333.667 9 2 11s5.333
 5.333 12 10c90.667 54 156 130 196 228 3.333 10.667 6.333 16.333 9 17 2 .667 5
 1 9 1h5c10.667 0 16.667-2 18-6 2-2.667 1-9.667-3-21-32-87.333-82.667-157.667
-152-211l-3-3h399907v-40zM93 281 H400000 v-40L7 241z`,leftharpoondownplus:`M7 435c-4 4-6.3 8.7-7 14 0 5.3.7 9 2 11s5.3 5.3 12
 10c90.7 54 156 130 196 228 3.3 10.7 6.3 16.3 9 17 2 .7 5 1 9 1h5c10.7 0 16.7
-2 18-6 2-2.7 1-9.7-3-21-32-87.3-82.7-157.7-152-211l-3-3h399907v-40H7zm93 0
v40h399900v-40zM0 241v40h399900v-40zm0 0v40h399900v-40z`,lefthook:`M400000 281 H103s-33-11.2-61-33.5S0 197.3 0 164s14.2-61.2 42.5
-83.5C70.8 58.2 104 47 142 47 c16.7 0 25 6.7 25 20 0 12-8.7 18.7-26 20-40 3.3
-68.7 15.7-86 37-10 12-15 25.3-15 40 0 22.7 9.8 40.7 29.5 54 19.7 13.3 43.5 21
 71.5 23h399859zM103 281v-40h399897v40z`,leftlinesegment:`M40 281 V428 H0 V94 H40 V241 H400000 v40z
M40 281 V428 H0 V94 H40 V241 H400000 v40z`,leftmapsto:`M40 281 V448H0V74H40V241H400000v40z
M40 281 V448H0V74H40V241H400000v40z`,leftToFrom:`M0 147h400000v40H0zm0 214c68 40 115.7 95.7 143 167h22c15.3 0 23
-.3 23-1 0-1.3-5.3-13.7-16-37-18-35.3-41.3-69-70-101l-7-8h399905v-40H95l7-8
c28.7-32 52-65.7 70-101 10.7-23.3 16-35.7 16-37 0-.7-7.7-1-23-1h-22C115.7 265.3
 68 321 0 361zm0-174v-40h399900v40zm100 154v40h399900v-40z`,longequal:`M0 50 h400000 v40H0z m0 194h40000v40H0z
M0 50 h400000 v40H0z m0 194h40000v40H0z`,midbrace:`M200428 334
c-100.7-8.3-195.3-44-280-108-55.3-42-101.7-93-139-153l-9-14c-2.7 4-5.7 8.7-9 14
-53.3 86.7-123.7 153-211 199-66.7 36-137.3 56.3-212 62H0V214h199568c178.3-11.7
 311.7-78.3 403-201 6-8 9.7-12 11-12 .7-.7 6.7-1 18-1s17.3.3 18 1c1.3 0 5 4 11
 12 44.7 59.3 101.3 106.3 170 141s145.3 54.3 229 60h199572v120z`,midbraceunder:`M199572 214
c100.7 8.3 195.3 44 280 108 55.3 42 101.7 93 139 153l9 14c2.7-4 5.7-8.7 9-14
 53.3-86.7 123.7-153 211-199 66.7-36 137.3-56.3 212-62h199568v120H200432c-178.3
 11.7-311.7 78.3-403 201-6 8-9.7 12-11 12-.7.7-6.7 1-18 1s-17.3-.3-18-1c-1.3 0
-5-4-11-12-44.7-59.3-101.3-106.3-170-141s-145.3-54.3-229-60H0V214z`,oiintSize1:`M512.6 71.6c272.6 0 320.3 106.8 320.3 178.2 0 70.8-47.7 177.6
-320.3 177.6S193.1 320.6 193.1 249.8c0-71.4 46.9-178.2 319.5-178.2z
m368.1 178.2c0-86.4-60.9-215.4-368.1-215.4-306.4 0-367.3 129-367.3 215.4 0 85.8
60.9 214.8 367.3 214.8 307.2 0 368.1-129 368.1-214.8z`,oiintSize2:`M757.8 100.1c384.7 0 451.1 137.6 451.1 230 0 91.3-66.4 228.8
-451.1 228.8-386.3 0-452.7-137.5-452.7-228.8 0-92.4 66.4-230 452.7-230z
m502.4 230c0-111.2-82.4-277.2-502.4-277.2s-504 166-504 277.2
c0 110 84 276 504 276s502.4-166 502.4-276z`,oiiintSize1:`M681.4 71.6c408.9 0 480.5 106.8 480.5 178.2 0 70.8-71.6 177.6
-480.5 177.6S202.1 320.6 202.1 249.8c0-71.4 70.5-178.2 479.3-178.2z
m525.8 178.2c0-86.4-86.8-215.4-525.7-215.4-437.9 0-524.7 129-524.7 215.4 0
85.8 86.8 214.8 524.7 214.8 438.9 0 525.7-129 525.7-214.8z`,oiiintSize2:`M1021.2 53c603.6 0 707.8 165.8 707.8 277.2 0 110-104.2 275.8
-707.8 275.8-606 0-710.2-165.8-710.2-275.8C311 218.8 415.2 53 1021.2 53z
m770.4 277.1c0-131.2-126.4-327.6-770.5-327.6S248.4 198.9 248.4 330.1
c0 130 128.8 326.4 772.7 326.4s770.5-196.4 770.5-326.4z`,rightarrow:`M0 241v40h399891c-47.3 35.3-84 78-110 128
-16.7 32-27.7 63.7-33 95 0 1.3-.2 2.7-.5 4-.3 1.3-.5 2.3-.5 3 0 7.3 6.7 11 20
 11 8 0 13.2-.8 15.5-2.5 2.3-1.7 4.2-5.5 5.5-11.5 2-13.3 5.7-27 11-41 14.7-44.7
 39-84.5 73-119.5s73.7-60.2 119-75.5c6-2 9-5.7 9-11s-3-9-9-11c-45.3-15.3-85
-40.5-119-75.5s-58.3-74.8-73-119.5c-4.7-14-8.3-27.3-11-40-1.3-6.7-3.2-10.8-5.5
-12.5-2.3-1.7-7.5-2.5-15.5-2.5-14 0-21 3.7-21 11 0 2 2 10.3 6 25 20.7 83.3 67
 151.7 139 205zm0 0v40h399900v-40z`,rightbrace:`M400000 542l
-6 6h-17c-12.7 0-19.3-.3-20-1-4-4-7.3-8.3-10-13-35.3-51.3-80.8-93.8-136.5-127.5
s-117.2-55.8-184.5-66.5c-.7 0-2-.3-4-1-18.7-2.7-76-4.3-172-5H0V214h399571l6 1
c124.7 8 235 61.7 331 161 31.3 33.3 59.7 72.7 85 118l7 13v35z`,rightbraceunder:`M399994 0l6 6v35l-6 11c-56 104-135.3 181.3-238 232-57.3
 28.7-117 45-179 50H-300V214h399897c43.3-7 81-15 113-26 100.7-33 179.7-91 237
-174 2.7-5 6-9 10-13 .7-1 7.3-1 20-1h17z`,rightgroup:`M0 80h399565c371 0 266.7 149.4 414 180 5.9 1.2 18 0 18 0 2 0
 3-1 3-3v-38c-76-158-257-219-435-219H0z`,rightgroupunder:`M0 262h399565c371 0 266.7-149.4 414-180 5.9-1.2 18 0 18
 0 2 0 3 1 3 3v38c-76 158-257 219-435 219H0z`,rightharpoon:`M0 241v40h399993c4.7-4.7 7-9.3 7-14 0-9.3
-3.7-15.3-11-18-92.7-56.7-159-133.7-199-231-3.3-9.3-6-14.7-8-16-2-1.3-7-2-15-2
-10.7 0-16.7 2-18 6-2 2.7-1 9.7 3 21 15.3 42 36.7 81.8 64 119.5 27.3 37.7 58
 69.2 92 94.5zm0 0v40h399900v-40z`,rightharpoonplus:`M0 241v40h399993c4.7-4.7 7-9.3 7-14 0-9.3-3.7-15.3-11
-18-92.7-56.7-159-133.7-199-231-3.3-9.3-6-14.7-8-16-2-1.3-7-2-15-2-10.7 0-16.7
 2-18 6-2 2.7-1 9.7 3 21 15.3 42 36.7 81.8 64 119.5 27.3 37.7 58 69.2 92 94.5z
m0 0v40h399900v-40z m100 194v40h399900v-40zm0 0v40h399900v-40z`,rightharpoondown:`M399747 511c0 7.3 6.7 11 20 11 8 0 13-.8 15-2.5s4.7-6.8
 8-15.5c40-94 99.3-166.3 178-217 13.3-8 20.3-12.3 21-13 5.3-3.3 8.5-5.8 9.5
-7.5 1-1.7 1.5-5.2 1.5-10.5s-2.3-10.3-7-15H0v40h399908c-34 25.3-64.7 57-92 95
-27.3 38-48.7 77.7-64 119-3.3 8.7-5 14-5 16zM0 241v40h399900v-40z`,rightharpoondownplus:`M399747 705c0 7.3 6.7 11 20 11 8 0 13-.8
 15-2.5s4.7-6.8 8-15.5c40-94 99.3-166.3 178-217 13.3-8 20.3-12.3 21-13 5.3-3.3
 8.5-5.8 9.5-7.5 1-1.7 1.5-5.2 1.5-10.5s-2.3-10.3-7-15H0v40h399908c-34 25.3
-64.7 57-92 95-27.3 38-48.7 77.7-64 119-3.3 8.7-5 14-5 16zM0 435v40h399900v-40z
m0-194v40h400000v-40zm0 0v40h400000v-40z`,righthook:`M399859 241c-764 0 0 0 0 0 40-3.3 68.7-15.7 86-37 10-12 15-25.3
 15-40 0-22.7-9.8-40.7-29.5-54-19.7-13.3-43.5-21-71.5-23-17.3-1.3-26-8-26-20 0
-13.3 8.7-20 26-20 38 0 71 11.2 99 33.5 0 0 7 5.6 21 16.7 14 11.2 21 33.5 21
 66.8s-14 61.2-42 83.5c-28 22.3-61 33.5-99 33.5L0 241z M0 281v-40h399859v40z`,rightlinesegment:`M399960 241 V94 h40 V428 h-40 V281 H0 v-40z
M399960 241 V94 h40 V428 h-40 V281 H0 v-40z`,rightToFrom:`M400000 167c-70.7-42-118-97.7-142-167h-23c-15.3 0-23 .3-23
 1 0 1.3 5.3 13.7 16 37 18 35.3 41.3 69 70 101l7 8H0v40h399905l-7 8c-28.7 32
-52 65.7-70 101-10.7 23.3-16 35.7-16 37 0 .7 7.7 1 23 1h23c24-69.3 71.3-125 142
-167z M100 147v40h399900v-40zM0 341v40h399900v-40z`,twoheadleftarrow:`M0 167c68 40
 115.7 95.7 143 167h22c15.3 0 23-.3 23-1 0-1.3-5.3-13.7-16-37-18-35.3-41.3-69
-70-101l-7-8h125l9 7c50.7 39.3 85 86 103 140h46c0-4.7-6.3-18.7-19-42-18-35.3
-40-67.3-66-96l-9-9h399716v-40H284l9-9c26-28.7 48-60.7 66-96 12.7-23.333 19
-37.333 19-42h-46c-18 54-52.3 100.7-103 140l-9 7H95l7-8c28.7-32 52-65.7 70-101
 10.7-23.333 16-35.7 16-37 0-.7-7.7-1-23-1h-22C115.7 71.3 68 127 0 167z`,twoheadrightarrow:`M400000 167
c-68-40-115.7-95.7-143-167h-22c-15.3 0-23 .3-23 1 0 1.3 5.3 13.7 16 37 18 35.3
 41.3 69 70 101l7 8h-125l-9-7c-50.7-39.3-85-86-103-140h-46c0 4.7 6.3 18.7 19 42
 18 35.3 40 67.3 66 96l9 9H0v40h399716l-9 9c-26 28.7-48 60.7-66 96-12.7 23.333
-19 37.333-19 42h46c18-54 52.3-100.7 103-140l9-7h125l-7 8c-28.7 32-52 65.7-70
 101-10.7 23.333-16 35.7-16 37 0 .7 7.7 1 23 1h22c27.3-71.3 75-127 143-167z`,tilde1:`M200 55.538c-77 0-168 73.953-177 73.953-3 0-7
-2.175-9-5.437L2 97c-1-2-2-4-2-6 0-4 2-7 5-9l20-12C116 12 171 0 207 0c86 0
 114 68 191 68 78 0 168-68 177-68 4 0 7 2 9 5l12 19c1 2.175 2 4.35 2 6.525 0
 4.35-2 7.613-5 9.788l-19 13.05c-92 63.077-116.937 75.308-183 76.128
-68.267.847-113-73.952-191-73.952z`,tilde2:`M344 55.266c-142 0-300.638 81.316-311.5 86.418
-8.01 3.762-22.5 10.91-23.5 5.562L1 120c-1-2-1-3-1-4 0-5 3-9 8-10l18.4-9C160.9
 31.9 283 0 358 0c148 0 188 122 331 122s314-97 326-97c4 0 8 2 10 7l7 21.114
c1 2.14 1 3.21 1 4.28 0 5.347-3 9.626-7 10.696l-22.3 12.622C852.6 158.372 751
 181.476 676 181.476c-149 0-189-126.21-332-126.21z`,tilde3:`M786 59C457 59 32 175.242 13 175.242c-6 0-10-3.457
-11-10.37L.15 138c-1-7 3-12 10-13l19.2-6.4C378.4 40.7 634.3 0 804.3 0c337 0
 411.8 157 746.8 157 328 0 754-112 773-112 5 0 10 3 11 9l1 14.075c1 8.066-.697
 16.595-6.697 17.492l-21.052 7.31c-367.9 98.146-609.15 122.696-778.15 122.696
 -338 0-409-156.573-744-156.573z`,tilde4:`M786 58C457 58 32 177.487 13 177.487c-6 0-10-3.345
-11-10.035L.15 143c-1-7 3-12 10-13l22-6.7C381.2 35 637.15 0 807.15 0c337 0 409
 177 744 177 328 0 754-127 773-127 5 0 10 3 11 9l1 14.794c1 7.805-3 13.38-9
 14.495l-20.7 5.574c-366.85 99.79-607.3 139.372-776.3 139.372-338 0-409
 -175.236-744-175.236z`,vec:`M377 20c0-5.333 1.833-10 5.5-14S391 0 397 0c4.667 0 8.667 1.667 12 5
3.333 2.667 6.667 9 10 19 6.667 24.667 20.333 43.667 41 57 7.333 4.667 11
10.667 11 18 0 6-1 10-3 12s-6.667 5-14 9c-28.667 14.667-53.667 35.667-75 63
-1.333 1.333-3.167 3.5-5.5 6.5s-4 4.833-5 5.5c-1 .667-2.5 1.333-4.5 2s-4.333 1
-7 1c-4.667 0-9.167-1.833-13.5-5.5S337 184 337 178c0-12.667 15.667-32.333 47-59
H213l-171-1c-8.667-6-13-12.333-13-19 0-4.667 4.333-11.333 13-20h359
c-16-25.333-24-45-24-59z`,widehat1:`M529 0h5l519 115c5 1 9 5 9 10 0 1-1 2-1 3l-4 22
c-1 5-5 9-11 9h-2L532 67 19 159h-2c-5 0-9-4-11-9l-5-22c-1-6 2-12 8-13z`,widehat2:`M1181 0h2l1171 176c6 0 10 5 10 11l-2 23c-1 6-5 10
-11 10h-1L1182 67 15 220h-1c-6 0-10-4-11-10l-2-23c-1-6 4-11 10-11z`,widehat3:`M1181 0h2l1171 236c6 0 10 5 10 11l-2 23c-1 6-5 10
-11 10h-1L1182 67 15 280h-1c-6 0-10-4-11-10l-2-23c-1-6 4-11 10-11z`,widehat4:`M1181 0h2l1171 296c6 0 10 5 10 11l-2 23c-1 6-5 10
-11 10h-1L1182 67 15 340h-1c-6 0-10-4-11-10l-2-23c-1-6 4-11 10-11z`,widecheck1:`M529,159h5l519,-115c5,-1,9,-5,9,-10c0,-1,-1,-2,-1,-3l-4,-22c-1,
-5,-5,-9,-11,-9h-2l-512,92l-513,-92h-2c-5,0,-9,4,-11,9l-5,22c-1,6,2,12,8,13z`,widecheck2:`M1181,220h2l1171,-176c6,0,10,-5,10,-11l-2,-23c-1,-6,-5,-10,
-11,-10h-1l-1168,153l-1167,-153h-1c-6,0,-10,4,-11,10l-2,23c-1,6,4,11,10,11z`,widecheck3:`M1181,280h2l1171,-236c6,0,10,-5,10,-11l-2,-23c-1,-6,-5,-10,
-11,-10h-1l-1168,213l-1167,-213h-1c-6,0,-10,4,-11,10l-2,23c-1,6,4,11,10,11z`,widecheck4:`M1181,340h2l1171,-296c6,0,10,-5,10,-11l-2,-23c-1,-6,-5,-10,
-11,-10h-1l-1168,273l-1167,-273h-1c-6,0,-10,4,-11,10l-2,23c-1,6,4,11,10,11z`,baraboveleftarrow:`M400000 620h-399890l3 -3c68.7 -52.7 113.7 -120 135 -202
c4 -14.7 6 -23 6 -25c0 -7.3 -7 -11 -21 -11c-8 0 -13.2 0.8 -15.5 2.5
c-2.3 1.7 -4.2 5.8 -5.5 12.5c-1.3 4.7 -2.7 10.3 -4 17c-12 48.7 -34.8 92 -68.5 130
s-74.2 66.3 -121.5 85c-10 4 -16 7.7 -18 11c0 8.7 6 14.3 18 17c47.3 18.7 87.8 47
121.5 85s56.5 81.3 68.5 130c0.7 2 1.3 5 2 9s1.2 6.7 1.5 8c0.3 1.3 1 3.3 2 6
s2.2 4.5 3.5 5.5c1.3 1 3.3 1.8 6 2.5s6 1 10 1c14 0 21 -3.7 21 -11
c0 -2 -2 -10.3 -6 -25c-20 -79.3 -65 -146.7 -135 -202l-3 -3h399890z
M100 620v40h399900v-40z M0 241v40h399900v-40zM0 241v40h399900v-40z`,rightarrowabovebar:`M0 241v40h399891c-47.3 35.3-84 78-110 128-16.7 32
-27.7 63.7-33 95 0 1.3-.2 2.7-.5 4-.3 1.3-.5 2.3-.5 3 0 7.3 6.7 11 20 11 8 0
13.2-.8 15.5-2.5 2.3-1.7 4.2-5.5 5.5-11.5 2-13.3 5.7-27 11-41 14.7-44.7 39
-84.5 73-119.5s73.7-60.2 119-75.5c6-2 9-5.7 9-11s-3-9-9-11c-45.3-15.3-85-40.5
-119-75.5s-58.3-74.8-73-119.5c-4.7-14-8.3-27.3-11-40-1.3-6.7-3.2-10.8-5.5
-12.5-2.3-1.7-7.5-2.5-15.5-2.5-14 0-21 3.7-21 11 0 2 2 10.3 6 25 20.7 83.3 67
151.7 139 205zm96 379h399894v40H0zm0 0h399904v40H0z`,baraboveshortleftharpoon:`M507,435c-4,4,-6.3,8.7,-7,14c0,5.3,0.7,9,2,11
c1.3,2,5.3,5.3,12,10c90.7,54,156,130,196,228c3.3,10.7,6.3,16.3,9,17
c2,0.7,5,1,9,1c0,0,5,0,5,0c10.7,0,16.7,-2,18,-6c2,-2.7,1,-9.7,-3,-21
c-32,-87.3,-82.7,-157.7,-152,-211c0,0,-3,-3,-3,-3l399351,0l0,-40
c-398570,0,-399437,0,-399437,0z M593 435 v40 H399500 v-40z
M0 281 v-40 H399908 v40z M0 281 v-40 H399908 v40z`,rightharpoonaboveshortbar:`M0,241 l0,40c399126,0,399993,0,399993,0
c4.7,-4.7,7,-9.3,7,-14c0,-9.3,-3.7,-15.3,-11,-18c-92.7,-56.7,-159,-133.7,-199,
-231c-3.3,-9.3,-6,-14.7,-8,-16c-2,-1.3,-7,-2,-15,-2c-10.7,0,-16.7,2,-18,6
c-2,2.7,-1,9.7,3,21c15.3,42,36.7,81.8,64,119.5c27.3,37.7,58,69.2,92,94.5z
M0 241 v40 H399908 v-40z M0 475 v-40 H399500 v40z M0 475 v-40 H399500 v40z`,shortbaraboveleftharpoon:`M7,435c-4,4,-6.3,8.7,-7,14c0,5.3,0.7,9,2,11
c1.3,2,5.3,5.3,12,10c90.7,54,156,130,196,228c3.3,10.7,6.3,16.3,9,17c2,0.7,5,1,9,
1c0,0,5,0,5,0c10.7,0,16.7,-2,18,-6c2,-2.7,1,-9.7,-3,-21c-32,-87.3,-82.7,-157.7,
-152,-211c0,0,-3,-3,-3,-3l399907,0l0,-40c-399126,0,-399993,0,-399993,0z
M93 435 v40 H400000 v-40z M500 241 v40 H400000 v-40z M500 241 v40 H400000 v-40z`,shortrightharpoonabovebar:`M53,241l0,40c398570,0,399437,0,399437,0
c4.7,-4.7,7,-9.3,7,-14c0,-9.3,-3.7,-15.3,-11,-18c-92.7,-56.7,-159,-133.7,-199,
-231c-3.3,-9.3,-6,-14.7,-8,-16c-2,-1.3,-7,-2,-15,-2c-10.7,0,-16.7,2,-18,6
c-2,2.7,-1,9.7,3,21c15.3,42,36.7,81.8,64,119.5c27.3,37.7,58,69.2,92,94.5z
M500 241 v40 H399408 v-40z M500 435 v40 H400000 v-40z`},Pa=function(e,t){switch(e){case"lbrack":return"M403 1759 V84 H666 V0 H319 V1759 v"+t+` v1759 h347 v-84
H403z M403 1759 V0 H319 V1759 v`+t+" v1759 h84z";case"rbrack":return"M347 1759 V0 H0 V84 H263 V1759 v"+t+` v1759 H0 v84 H347z
M347 1759 V0 H263 V1759 v`+t+" v1759 h84z";case"vert":return"M145 15 v585 v"+t+` v585 c2.667,10,9.667,15,21,15
c10,0,16.667,-5,20,-15 v-585 v`+-t+` v-585 c-2.667,-10,-9.667,-15,-21,-15
c-10,0,-16.667,5,-20,15z M188 15 H145 v585 v`+t+" v585 h43z";case"doublevert":return"M145 15 v585 v"+t+` v585 c2.667,10,9.667,15,21,15
c10,0,16.667,-5,20,-15 v-585 v`+-t+` v-585 c-2.667,-10,-9.667,-15,-21,-15
c-10,0,-16.667,5,-20,15z M188 15 H145 v585 v`+t+` v585 h43z
M367 15 v585 v`+t+` v585 c2.667,10,9.667,15,21,15
c10,0,16.667,-5,20,-15 v-585 v`+-t+` v-585 c-2.667,-10,-9.667,-15,-21,-15
c-10,0,-16.667,5,-20,15z M410 15 H367 v585 v`+t+" v585 h43z";case"lfloor":return"M319 602 V0 H403 V602 v"+t+` v1715 h263 v84 H319z
MM319 602 V0 H403 V602 v`+t+" v1715 H319z";case"rfloor":return"M319 602 V0 H403 V602 v"+t+` v1799 H0 v-84 H319z
MM319 602 V0 H403 V602 v`+t+" v1715 H319z";case"lceil":return"M403 1759 V84 H666 V0 H319 V1759 v"+t+` v602 h84z
M403 1759 V0 H319 V1759 v`+t+" v602 h84z";case"rceil":return"M347 1759 V0 H0 V84 H263 V1759 v"+t+` v602 h84z
M347 1759 V0 h-84 V1759 v`+t+" v602 h84z";case"lparen":return`M863,9c0,-2,-2,-5,-6,-9c0,0,-17,0,-17,0c-12.7,0,-19.3,0.3,-20,1
c-5.3,5.3,-10.3,11,-15,17c-242.7,294.7,-395.3,682,-458,1162c-21.3,163.3,-33.3,349,
-36,557 l0,`+(t+84)+`c0.2,6,0,26,0,60c2,159.3,10,310.7,24,454c53.3,528,210,
949.7,470,1265c4.7,6,9.7,11.7,15,17c0.7,0.7,7,1,19,1c0,0,18,0,18,0c4,-4,6,-7,6,-9
c0,-2.7,-3.3,-8.7,-10,-18c-135.3,-192.7,-235.5,-414.3,-300.5,-665c-65,-250.7,-102.5,
-544.7,-112.5,-882c-2,-104,-3,-167,-3,-189
l0,-`+(t+92)+`c0,-162.7,5.7,-314,17,-454c20.7,-272,63.7,-513,129,-723c65.3,
-210,155.3,-396.3,270,-559c6.7,-9.3,10,-15.3,10,-18z`;case"rparen":return`M76,0c-16.7,0,-25,3,-25,9c0,2,2,6.3,6,13c21.3,28.7,42.3,60.3,
63,95c96.7,156.7,172.8,332.5,228.5,527.5c55.7,195,92.8,416.5,111.5,664.5
c11.3,139.3,17,290.7,17,454c0,28,1.7,43,3.3,45l0,`+(t+9)+`
c-3,4,-3.3,16.7,-3.3,38c0,162,-5.7,313.7,-17,455c-18.7,248,-55.8,469.3,-111.5,664
c-55.7,194.7,-131.8,370.3,-228.5,527c-20.7,34.7,-41.7,66.3,-63,95c-2,3.3,-4,7,-6,11
c0,7.3,5.7,11,17,11c0,0,11,0,11,0c9.3,0,14.3,-0.3,15,-1c5.3,-5.3,10.3,-11,15,-17
c242.7,-294.7,395.3,-681.7,458,-1161c21.3,-164.7,33.3,-350.7,36,-558
l0,-`+(t+144)+`c-2,-159.3,-10,-310.7,-24,-454c-53.3,-528,-210,-949.7,
-470,-1265c-4.7,-6,-9.7,-11.7,-15,-17c-0.7,-0.7,-6.7,-1,-18,-1z`;default:throw new Error("Unknown stretchy delimiter.")}};class he{constructor(e){this.children=void 0,this.classes=void 0,this.height=void 0,this.depth=void 0,this.maxFontSize=void 0,this.style=void 0,this.children=e,this.classes=[],this.height=0,this.depth=0,this.maxFontSize=0,this.style={}}hasClass(e){return this.classes.includes(e)}toNode(){for(var e=document.createDocumentFragment(),t=0;t<this.children.length;t++)e.appendChild(this.children[t].toNode());return e}toMarkup(){for(var e="",t=0;t<this.children.length;t++)e+=this.children[t].toMarkup();return e}toText(){var e=t=>t.toText();return this.children.map(e).join("")}}var w0={"AMS-Regular":{32:[0,0,0,0,.25],65:[0,.68889,0,0,.72222],66:[0,.68889,0,0,.66667],67:[0,.68889,0,0,.72222],68:[0,.68889,0,0,.72222],69:[0,.68889,0,0,.66667],70:[0,.68889,0,0,.61111],71:[0,.68889,0,0,.77778],72:[0,.68889,0,0,.77778],73:[0,.68889,0,0,.38889],74:[.16667,.68889,0,0,.5],75:[0,.68889,0,0,.77778],76:[0,.68889,0,0,.66667],77:[0,.68889,0,0,.94445],78:[0,.68889,0,0,.72222],79:[.16667,.68889,0,0,.77778],80:[0,.68889,0,0,.61111],81:[.16667,.68889,0,0,.77778],82:[0,.68889,0,0,.72222],83:[0,.68889,0,0,.55556],84:[0,.68889,0,0,.66667],85:[0,.68889,0,0,.72222],86:[0,.68889,0,0,.72222],87:[0,.68889,0,0,1],88:[0,.68889,0,0,.72222],89:[0,.68889,0,0,.72222],90:[0,.68889,0,0,.66667],107:[0,.68889,0,0,.55556],160:[0,0,0,0,.25],165:[0,.675,.025,0,.75],174:[.15559,.69224,0,0,.94666],240:[0,.68889,0,0,.55556],295:[0,.68889,0,0,.54028],710:[0,.825,0,0,2.33334],732:[0,.9,0,0,2.33334],770:[0,.825,0,0,2.33334],771:[0,.9,0,0,2.33334],989:[.08167,.58167,0,0,.77778],1008:[0,.43056,.04028,0,.66667],8245:[0,.54986,0,0,.275],8463:[0,.68889,0,0,.54028],8487:[0,.68889,0,0,.72222],8498:[0,.68889,0,0,.55556],8502:[0,.68889,0,0,.66667],8503:[0,.68889,0,0,.44445],8504:[0,.68889,0,0,.66667],8513:[0,.68889,0,0,.63889],8592:[-.03598,.46402,0,0,.5],8594:[-.03598,.46402,0,0,.5],8602:[-.13313,.36687,0,0,1],8603:[-.13313,.36687,0,0,1],8606:[.01354,.52239,0,0,1],8608:[.01354,.52239,0,0,1],8610:[.01354,.52239,0,0,1.11111],8611:[.01354,.52239,0,0,1.11111],8619:[0,.54986,0,0,1],8620:[0,.54986,0,0,1],8621:[-.13313,.37788,0,0,1.38889],8622:[-.13313,.36687,0,0,1],8624:[0,.69224,0,0,.5],8625:[0,.69224,0,0,.5],8630:[0,.43056,0,0,1],8631:[0,.43056,0,0,1],8634:[.08198,.58198,0,0,.77778],8635:[.08198,.58198,0,0,.77778],8638:[.19444,.69224,0,0,.41667],8639:[.19444,.69224,0,0,.41667],8642:[.19444,.69224,0,0,.41667],8643:[.19444,.69224,0,0,.41667],8644:[.1808,.675,0,0,1],8646:[.1808,.675,0,0,1],8647:[.1808,.675,0,0,1],8648:[.19444,.69224,0,0,.83334],8649:[.1808,.675,0,0,1],8650:[.19444,.69224,0,0,.83334],8651:[.01354,.52239,0,0,1],8652:[.01354,.52239,0,0,1],8653:[-.13313,.36687,0,0,1],8654:[-.13313,.36687,0,0,1],8655:[-.13313,.36687,0,0,1],8666:[.13667,.63667,0,0,1],8667:[.13667,.63667,0,0,1],8669:[-.13313,.37788,0,0,1],8672:[-.064,.437,0,0,1.334],8674:[-.064,.437,0,0,1.334],8705:[0,.825,0,0,.5],8708:[0,.68889,0,0,.55556],8709:[.08167,.58167,0,0,.77778],8717:[0,.43056,0,0,.42917],8722:[-.03598,.46402,0,0,.5],8724:[.08198,.69224,0,0,.77778],8726:[.08167,.58167,0,0,.77778],8733:[0,.69224,0,0,.77778],8736:[0,.69224,0,0,.72222],8737:[0,.69224,0,0,.72222],8738:[.03517,.52239,0,0,.72222],8739:[.08167,.58167,0,0,.22222],8740:[.25142,.74111,0,0,.27778],8741:[.08167,.58167,0,0,.38889],8742:[.25142,.74111,0,0,.5],8756:[0,.69224,0,0,.66667],8757:[0,.69224,0,0,.66667],8764:[-.13313,.36687,0,0,.77778],8765:[-.13313,.37788,0,0,.77778],8769:[-.13313,.36687,0,0,.77778],8770:[-.03625,.46375,0,0,.77778],8774:[.30274,.79383,0,0,.77778],8776:[-.01688,.48312,0,0,.77778],8778:[.08167,.58167,0,0,.77778],8782:[.06062,.54986,0,0,.77778],8783:[.06062,.54986,0,0,.77778],8785:[.08198,.58198,0,0,.77778],8786:[.08198,.58198,0,0,.77778],8787:[.08198,.58198,0,0,.77778],8790:[0,.69224,0,0,.77778],8791:[.22958,.72958,0,0,.77778],8796:[.08198,.91667,0,0,.77778],8806:[.25583,.75583,0,0,.77778],8807:[.25583,.75583,0,0,.77778],8808:[.25142,.75726,0,0,.77778],8809:[.25142,.75726,0,0,.77778],8812:[.25583,.75583,0,0,.5],8814:[.20576,.70576,0,0,.77778],8815:[.20576,.70576,0,0,.77778],8816:[.30274,.79383,0,0,.77778],8817:[.30274,.79383,0,0,.77778],8818:[.22958,.72958,0,0,.77778],8819:[.22958,.72958,0,0,.77778],8822:[.1808,.675,0,0,.77778],8823:[.1808,.675,0,0,.77778],8828:[.13667,.63667,0,0,.77778],8829:[.13667,.63667,0,0,.77778],8830:[.22958,.72958,0,0,.77778],8831:[.22958,.72958,0,0,.77778],8832:[.20576,.70576,0,0,.77778],8833:[.20576,.70576,0,0,.77778],8840:[.30274,.79383,0,0,.77778],8841:[.30274,.79383,0,0,.77778],8842:[.13597,.63597,0,0,.77778],8843:[.13597,.63597,0,0,.77778],8847:[.03517,.54986,0,0,.77778],8848:[.03517,.54986,0,0,.77778],8858:[.08198,.58198,0,0,.77778],8859:[.08198,.58198,0,0,.77778],8861:[.08198,.58198,0,0,.77778],8862:[0,.675,0,0,.77778],8863:[0,.675,0,0,.77778],8864:[0,.675,0,0,.77778],8865:[0,.675,0,0,.77778],8872:[0,.69224,0,0,.61111],8873:[0,.69224,0,0,.72222],8874:[0,.69224,0,0,.88889],8876:[0,.68889,0,0,.61111],8877:[0,.68889,0,0,.61111],8878:[0,.68889,0,0,.72222],8879:[0,.68889,0,0,.72222],8882:[.03517,.54986,0,0,.77778],8883:[.03517,.54986,0,0,.77778],8884:[.13667,.63667,0,0,.77778],8885:[.13667,.63667,0,0,.77778],8888:[0,.54986,0,0,1.11111],8890:[.19444,.43056,0,0,.55556],8891:[.19444,.69224,0,0,.61111],8892:[.19444,.69224,0,0,.61111],8901:[0,.54986,0,0,.27778],8903:[.08167,.58167,0,0,.77778],8905:[.08167,.58167,0,0,.77778],8906:[.08167,.58167,0,0,.77778],8907:[0,.69224,0,0,.77778],8908:[0,.69224,0,0,.77778],8909:[-.03598,.46402,0,0,.77778],8910:[0,.54986,0,0,.76042],8911:[0,.54986,0,0,.76042],8912:[.03517,.54986,0,0,.77778],8913:[.03517,.54986,0,0,.77778],8914:[0,.54986,0,0,.66667],8915:[0,.54986,0,0,.66667],8916:[0,.69224,0,0,.66667],8918:[.0391,.5391,0,0,.77778],8919:[.0391,.5391,0,0,.77778],8920:[.03517,.54986,0,0,1.33334],8921:[.03517,.54986,0,0,1.33334],8922:[.38569,.88569,0,0,.77778],8923:[.38569,.88569,0,0,.77778],8926:[.13667,.63667,0,0,.77778],8927:[.13667,.63667,0,0,.77778],8928:[.30274,.79383,0,0,.77778],8929:[.30274,.79383,0,0,.77778],8934:[.23222,.74111,0,0,.77778],8935:[.23222,.74111,0,0,.77778],8936:[.23222,.74111,0,0,.77778],8937:[.23222,.74111,0,0,.77778],8938:[.20576,.70576,0,0,.77778],8939:[.20576,.70576,0,0,.77778],8940:[.30274,.79383,0,0,.77778],8941:[.30274,.79383,0,0,.77778],8994:[.19444,.69224,0,0,.77778],8995:[.19444,.69224,0,0,.77778],9416:[.15559,.69224,0,0,.90222],9484:[0,.69224,0,0,.5],9488:[0,.69224,0,0,.5],9492:[0,.37788,0,0,.5],9496:[0,.37788,0,0,.5],9585:[.19444,.68889,0,0,.88889],9586:[.19444,.74111,0,0,.88889],9632:[0,.675,0,0,.77778],9633:[0,.675,0,0,.77778],9650:[0,.54986,0,0,.72222],9651:[0,.54986,0,0,.72222],9654:[.03517,.54986,0,0,.77778],9660:[0,.54986,0,0,.72222],9661:[0,.54986,0,0,.72222],9664:[.03517,.54986,0,0,.77778],9674:[.11111,.69224,0,0,.66667],9733:[.19444,.69224,0,0,.94445],10003:[0,.69224,0,0,.83334],10016:[0,.69224,0,0,.83334],10731:[.11111,.69224,0,0,.66667],10846:[.19444,.75583,0,0,.61111],10877:[.13667,.63667,0,0,.77778],10878:[.13667,.63667,0,0,.77778],10885:[.25583,.75583,0,0,.77778],10886:[.25583,.75583,0,0,.77778],10887:[.13597,.63597,0,0,.77778],10888:[.13597,.63597,0,0,.77778],10889:[.26167,.75726,0,0,.77778],10890:[.26167,.75726,0,0,.77778],10891:[.48256,.98256,0,0,.77778],10892:[.48256,.98256,0,0,.77778],10901:[.13667,.63667,0,0,.77778],10902:[.13667,.63667,0,0,.77778],10933:[.25142,.75726,0,0,.77778],10934:[.25142,.75726,0,0,.77778],10935:[.26167,.75726,0,0,.77778],10936:[.26167,.75726,0,0,.77778],10937:[.26167,.75726,0,0,.77778],10938:[.26167,.75726,0,0,.77778],10949:[.25583,.75583,0,0,.77778],10950:[.25583,.75583,0,0,.77778],10955:[.28481,.79383,0,0,.77778],10956:[.28481,.79383,0,0,.77778],57350:[.08167,.58167,0,0,.22222],57351:[.08167,.58167,0,0,.38889],57352:[.08167,.58167,0,0,.77778],57353:[0,.43056,.04028,0,.66667],57356:[.25142,.75726,0,0,.77778],57357:[.25142,.75726,0,0,.77778],57358:[.41951,.91951,0,0,.77778],57359:[.30274,.79383,0,0,.77778],57360:[.30274,.79383,0,0,.77778],57361:[.41951,.91951,0,0,.77778],57366:[.25142,.75726,0,0,.77778],57367:[.25142,.75726,0,0,.77778],57368:[.25142,.75726,0,0,.77778],57369:[.25142,.75726,0,0,.77778],57370:[.13597,.63597,0,0,.77778],57371:[.13597,.63597,0,0,.77778]},"Caligraphic-Regular":{32:[0,0,0,0,.25],65:[0,.68333,0,.19445,.79847],66:[0,.68333,.03041,.13889,.65681],67:[0,.68333,.05834,.13889,.52653],68:[0,.68333,.02778,.08334,.77139],69:[0,.68333,.08944,.11111,.52778],70:[0,.68333,.09931,.11111,.71875],71:[.09722,.68333,.0593,.11111,.59487],72:[0,.68333,.00965,.11111,.84452],73:[0,.68333,.07382,0,.54452],74:[.09722,.68333,.18472,.16667,.67778],75:[0,.68333,.01445,.05556,.76195],76:[0,.68333,0,.13889,.68972],77:[0,.68333,0,.13889,1.2009],78:[0,.68333,.14736,.08334,.82049],79:[0,.68333,.02778,.11111,.79611],80:[0,.68333,.08222,.08334,.69556],81:[.09722,.68333,0,.11111,.81667],82:[0,.68333,0,.08334,.8475],83:[0,.68333,.075,.13889,.60556],84:[0,.68333,.25417,0,.54464],85:[0,.68333,.09931,.08334,.62583],86:[0,.68333,.08222,0,.61278],87:[0,.68333,.08222,.08334,.98778],88:[0,.68333,.14643,.13889,.7133],89:[.09722,.68333,.08222,.08334,.66834],90:[0,.68333,.07944,.13889,.72473],160:[0,0,0,0,.25]},"Fraktur-Regular":{32:[0,0,0,0,.25],33:[0,.69141,0,0,.29574],34:[0,.69141,0,0,.21471],38:[0,.69141,0,0,.73786],39:[0,.69141,0,0,.21201],40:[.24982,.74947,0,0,.38865],41:[.24982,.74947,0,0,.38865],42:[0,.62119,0,0,.27764],43:[.08319,.58283,0,0,.75623],44:[0,.10803,0,0,.27764],45:[.08319,.58283,0,0,.75623],46:[0,.10803,0,0,.27764],47:[.24982,.74947,0,0,.50181],48:[0,.47534,0,0,.50181],49:[0,.47534,0,0,.50181],50:[0,.47534,0,0,.50181],51:[.18906,.47534,0,0,.50181],52:[.18906,.47534,0,0,.50181],53:[.18906,.47534,0,0,.50181],54:[0,.69141,0,0,.50181],55:[.18906,.47534,0,0,.50181],56:[0,.69141,0,0,.50181],57:[.18906,.47534,0,0,.50181],58:[0,.47534,0,0,.21606],59:[.12604,.47534,0,0,.21606],61:[-.13099,.36866,0,0,.75623],63:[0,.69141,0,0,.36245],65:[0,.69141,0,0,.7176],66:[0,.69141,0,0,.88397],67:[0,.69141,0,0,.61254],68:[0,.69141,0,0,.83158],69:[0,.69141,0,0,.66278],70:[.12604,.69141,0,0,.61119],71:[0,.69141,0,0,.78539],72:[.06302,.69141,0,0,.7203],73:[0,.69141,0,0,.55448],74:[.12604,.69141,0,0,.55231],75:[0,.69141,0,0,.66845],76:[0,.69141,0,0,.66602],77:[0,.69141,0,0,1.04953],78:[0,.69141,0,0,.83212],79:[0,.69141,0,0,.82699],80:[.18906,.69141,0,0,.82753],81:[.03781,.69141,0,0,.82699],82:[0,.69141,0,0,.82807],83:[0,.69141,0,0,.82861],84:[0,.69141,0,0,.66899],85:[0,.69141,0,0,.64576],86:[0,.69141,0,0,.83131],87:[0,.69141,0,0,1.04602],88:[0,.69141,0,0,.71922],89:[.18906,.69141,0,0,.83293],90:[.12604,.69141,0,0,.60201],91:[.24982,.74947,0,0,.27764],93:[.24982,.74947,0,0,.27764],94:[0,.69141,0,0,.49965],97:[0,.47534,0,0,.50046],98:[0,.69141,0,0,.51315],99:[0,.47534,0,0,.38946],100:[0,.62119,0,0,.49857],101:[0,.47534,0,0,.40053],102:[.18906,.69141,0,0,.32626],103:[.18906,.47534,0,0,.5037],104:[.18906,.69141,0,0,.52126],105:[0,.69141,0,0,.27899],106:[0,.69141,0,0,.28088],107:[0,.69141,0,0,.38946],108:[0,.69141,0,0,.27953],109:[0,.47534,0,0,.76676],110:[0,.47534,0,0,.52666],111:[0,.47534,0,0,.48885],112:[.18906,.52396,0,0,.50046],113:[.18906,.47534,0,0,.48912],114:[0,.47534,0,0,.38919],115:[0,.47534,0,0,.44266],116:[0,.62119,0,0,.33301],117:[0,.47534,0,0,.5172],118:[0,.52396,0,0,.5118],119:[0,.52396,0,0,.77351],120:[.18906,.47534,0,0,.38865],121:[.18906,.47534,0,0,.49884],122:[.18906,.47534,0,0,.39054],160:[0,0,0,0,.25],8216:[0,.69141,0,0,.21471],8217:[0,.69141,0,0,.21471],58112:[0,.62119,0,0,.49749],58113:[0,.62119,0,0,.4983],58114:[.18906,.69141,0,0,.33328],58115:[.18906,.69141,0,0,.32923],58116:[.18906,.47534,0,0,.50343],58117:[0,.69141,0,0,.33301],58118:[0,.62119,0,0,.33409],58119:[0,.47534,0,0,.50073]},"Main-Bold":{32:[0,0,0,0,.25],33:[0,.69444,0,0,.35],34:[0,.69444,0,0,.60278],35:[.19444,.69444,0,0,.95833],36:[.05556,.75,0,0,.575],37:[.05556,.75,0,0,.95833],38:[0,.69444,0,0,.89444],39:[0,.69444,0,0,.31944],40:[.25,.75,0,0,.44722],41:[.25,.75,0,0,.44722],42:[0,.75,0,0,.575],43:[.13333,.63333,0,0,.89444],44:[.19444,.15556,0,0,.31944],45:[0,.44444,0,0,.38333],46:[0,.15556,0,0,.31944],47:[.25,.75,0,0,.575],48:[0,.64444,0,0,.575],49:[0,.64444,0,0,.575],50:[0,.64444,0,0,.575],51:[0,.64444,0,0,.575],52:[0,.64444,0,0,.575],53:[0,.64444,0,0,.575],54:[0,.64444,0,0,.575],55:[0,.64444,0,0,.575],56:[0,.64444,0,0,.575],57:[0,.64444,0,0,.575],58:[0,.44444,0,0,.31944],59:[.19444,.44444,0,0,.31944],60:[.08556,.58556,0,0,.89444],61:[-.10889,.39111,0,0,.89444],62:[.08556,.58556,0,0,.89444],63:[0,.69444,0,0,.54305],64:[0,.69444,0,0,.89444],65:[0,.68611,0,0,.86944],66:[0,.68611,0,0,.81805],67:[0,.68611,0,0,.83055],68:[0,.68611,0,0,.88194],69:[0,.68611,0,0,.75555],70:[0,.68611,0,0,.72361],71:[0,.68611,0,0,.90416],72:[0,.68611,0,0,.9],73:[0,.68611,0,0,.43611],74:[0,.68611,0,0,.59444],75:[0,.68611,0,0,.90138],76:[0,.68611,0,0,.69166],77:[0,.68611,0,0,1.09166],78:[0,.68611,0,0,.9],79:[0,.68611,0,0,.86388],80:[0,.68611,0,0,.78611],81:[.19444,.68611,0,0,.86388],82:[0,.68611,0,0,.8625],83:[0,.68611,0,0,.63889],84:[0,.68611,0,0,.8],85:[0,.68611,0,0,.88472],86:[0,.68611,.01597,0,.86944],87:[0,.68611,.01597,0,1.18888],88:[0,.68611,0,0,.86944],89:[0,.68611,.02875,0,.86944],90:[0,.68611,0,0,.70277],91:[.25,.75,0,0,.31944],92:[.25,.75,0,0,.575],93:[.25,.75,0,0,.31944],94:[0,.69444,0,0,.575],95:[.31,.13444,.03194,0,.575],97:[0,.44444,0,0,.55902],98:[0,.69444,0,0,.63889],99:[0,.44444,0,0,.51111],100:[0,.69444,0,0,.63889],101:[0,.44444,0,0,.52708],102:[0,.69444,.10903,0,.35139],103:[.19444,.44444,.01597,0,.575],104:[0,.69444,0,0,.63889],105:[0,.69444,0,0,.31944],106:[.19444,.69444,0,0,.35139],107:[0,.69444,0,0,.60694],108:[0,.69444,0,0,.31944],109:[0,.44444,0,0,.95833],110:[0,.44444,0,0,.63889],111:[0,.44444,0,0,.575],112:[.19444,.44444,0,0,.63889],113:[.19444,.44444,0,0,.60694],114:[0,.44444,0,0,.47361],115:[0,.44444,0,0,.45361],116:[0,.63492,0,0,.44722],117:[0,.44444,0,0,.63889],118:[0,.44444,.01597,0,.60694],119:[0,.44444,.01597,0,.83055],120:[0,.44444,0,0,.60694],121:[.19444,.44444,.01597,0,.60694],122:[0,.44444,0,0,.51111],123:[.25,.75,0,0,.575],124:[.25,.75,0,0,.31944],125:[.25,.75,0,0,.575],126:[.35,.34444,0,0,.575],160:[0,0,0,0,.25],163:[0,.69444,0,0,.86853],168:[0,.69444,0,0,.575],172:[0,.44444,0,0,.76666],176:[0,.69444,0,0,.86944],177:[.13333,.63333,0,0,.89444],184:[.17014,0,0,0,.51111],198:[0,.68611,0,0,1.04166],215:[.13333,.63333,0,0,.89444],216:[.04861,.73472,0,0,.89444],223:[0,.69444,0,0,.59722],230:[0,.44444,0,0,.83055],247:[.13333,.63333,0,0,.89444],248:[.09722,.54167,0,0,.575],305:[0,.44444,0,0,.31944],338:[0,.68611,0,0,1.16944],339:[0,.44444,0,0,.89444],567:[.19444,.44444,0,0,.35139],710:[0,.69444,0,0,.575],711:[0,.63194,0,0,.575],713:[0,.59611,0,0,.575],714:[0,.69444,0,0,.575],715:[0,.69444,0,0,.575],728:[0,.69444,0,0,.575],729:[0,.69444,0,0,.31944],730:[0,.69444,0,0,.86944],732:[0,.69444,0,0,.575],733:[0,.69444,0,0,.575],915:[0,.68611,0,0,.69166],916:[0,.68611,0,0,.95833],920:[0,.68611,0,0,.89444],923:[0,.68611,0,0,.80555],926:[0,.68611,0,0,.76666],928:[0,.68611,0,0,.9],931:[0,.68611,0,0,.83055],933:[0,.68611,0,0,.89444],934:[0,.68611,0,0,.83055],936:[0,.68611,0,0,.89444],937:[0,.68611,0,0,.83055],8211:[0,.44444,.03194,0,.575],8212:[0,.44444,.03194,0,1.14999],8216:[0,.69444,0,0,.31944],8217:[0,.69444,0,0,.31944],8220:[0,.69444,0,0,.60278],8221:[0,.69444,0,0,.60278],8224:[.19444,.69444,0,0,.51111],8225:[.19444,.69444,0,0,.51111],8242:[0,.55556,0,0,.34444],8407:[0,.72444,.15486,0,.575],8463:[0,.69444,0,0,.66759],8465:[0,.69444,0,0,.83055],8467:[0,.69444,0,0,.47361],8472:[.19444,.44444,0,0,.74027],8476:[0,.69444,0,0,.83055],8501:[0,.69444,0,0,.70277],8592:[-.10889,.39111,0,0,1.14999],8593:[.19444,.69444,0,0,.575],8594:[-.10889,.39111,0,0,1.14999],8595:[.19444,.69444,0,0,.575],8596:[-.10889,.39111,0,0,1.14999],8597:[.25,.75,0,0,.575],8598:[.19444,.69444,0,0,1.14999],8599:[.19444,.69444,0,0,1.14999],8600:[.19444,.69444,0,0,1.14999],8601:[.19444,.69444,0,0,1.14999],8636:[-.10889,.39111,0,0,1.14999],8637:[-.10889,.39111,0,0,1.14999],8640:[-.10889,.39111,0,0,1.14999],8641:[-.10889,.39111,0,0,1.14999],8656:[-.10889,.39111,0,0,1.14999],8657:[.19444,.69444,0,0,.70277],8658:[-.10889,.39111,0,0,1.14999],8659:[.19444,.69444,0,0,.70277],8660:[-.10889,.39111,0,0,1.14999],8661:[.25,.75,0,0,.70277],8704:[0,.69444,0,0,.63889],8706:[0,.69444,.06389,0,.62847],8707:[0,.69444,0,0,.63889],8709:[.05556,.75,0,0,.575],8711:[0,.68611,0,0,.95833],8712:[.08556,.58556,0,0,.76666],8715:[.08556,.58556,0,0,.76666],8722:[.13333,.63333,0,0,.89444],8723:[.13333,.63333,0,0,.89444],8725:[.25,.75,0,0,.575],8726:[.25,.75,0,0,.575],8727:[-.02778,.47222,0,0,.575],8728:[-.02639,.47361,0,0,.575],8729:[-.02639,.47361,0,0,.575],8730:[.18,.82,0,0,.95833],8733:[0,.44444,0,0,.89444],8734:[0,.44444,0,0,1.14999],8736:[0,.69224,0,0,.72222],8739:[.25,.75,0,0,.31944],8741:[.25,.75,0,0,.575],8743:[0,.55556,0,0,.76666],8744:[0,.55556,0,0,.76666],8745:[0,.55556,0,0,.76666],8746:[0,.55556,0,0,.76666],8747:[.19444,.69444,.12778,0,.56875],8764:[-.10889,.39111,0,0,.89444],8768:[.19444,.69444,0,0,.31944],8771:[.00222,.50222,0,0,.89444],8773:[.027,.638,0,0,.894],8776:[.02444,.52444,0,0,.89444],8781:[.00222,.50222,0,0,.89444],8801:[.00222,.50222,0,0,.89444],8804:[.19667,.69667,0,0,.89444],8805:[.19667,.69667,0,0,.89444],8810:[.08556,.58556,0,0,1.14999],8811:[.08556,.58556,0,0,1.14999],8826:[.08556,.58556,0,0,.89444],8827:[.08556,.58556,0,0,.89444],8834:[.08556,.58556,0,0,.89444],8835:[.08556,.58556,0,0,.89444],8838:[.19667,.69667,0,0,.89444],8839:[.19667,.69667,0,0,.89444],8846:[0,.55556,0,0,.76666],8849:[.19667,.69667,0,0,.89444],8850:[.19667,.69667,0,0,.89444],8851:[0,.55556,0,0,.76666],8852:[0,.55556,0,0,.76666],8853:[.13333,.63333,0,0,.89444],8854:[.13333,.63333,0,0,.89444],8855:[.13333,.63333,0,0,.89444],8856:[.13333,.63333,0,0,.89444],8857:[.13333,.63333,0,0,.89444],8866:[0,.69444,0,0,.70277],8867:[0,.69444,0,0,.70277],8868:[0,.69444,0,0,.89444],8869:[0,.69444,0,0,.89444],8900:[-.02639,.47361,0,0,.575],8901:[-.02639,.47361,0,0,.31944],8902:[-.02778,.47222,0,0,.575],8968:[.25,.75,0,0,.51111],8969:[.25,.75,0,0,.51111],8970:[.25,.75,0,0,.51111],8971:[.25,.75,0,0,.51111],8994:[-.13889,.36111,0,0,1.14999],8995:[-.13889,.36111,0,0,1.14999],9651:[.19444,.69444,0,0,1.02222],9657:[-.02778,.47222,0,0,.575],9661:[.19444,.69444,0,0,1.02222],9667:[-.02778,.47222,0,0,.575],9711:[.19444,.69444,0,0,1.14999],9824:[.12963,.69444,0,0,.89444],9825:[.12963,.69444,0,0,.89444],9826:[.12963,.69444,0,0,.89444],9827:[.12963,.69444,0,0,.89444],9837:[0,.75,0,0,.44722],9838:[.19444,.69444,0,0,.44722],9839:[.19444,.69444,0,0,.44722],10216:[.25,.75,0,0,.44722],10217:[.25,.75,0,0,.44722],10815:[0,.68611,0,0,.9],10927:[.19667,.69667,0,0,.89444],10928:[.19667,.69667,0,0,.89444],57376:[.19444,.69444,0,0,0]},"Main-BoldItalic":{32:[0,0,0,0,.25],33:[0,.69444,.11417,0,.38611],34:[0,.69444,.07939,0,.62055],35:[.19444,.69444,.06833,0,.94444],37:[.05556,.75,.12861,0,.94444],38:[0,.69444,.08528,0,.88555],39:[0,.69444,.12945,0,.35555],40:[.25,.75,.15806,0,.47333],41:[.25,.75,.03306,0,.47333],42:[0,.75,.14333,0,.59111],43:[.10333,.60333,.03306,0,.88555],44:[.19444,.14722,0,0,.35555],45:[0,.44444,.02611,0,.41444],46:[0,.14722,0,0,.35555],47:[.25,.75,.15806,0,.59111],48:[0,.64444,.13167,0,.59111],49:[0,.64444,.13167,0,.59111],50:[0,.64444,.13167,0,.59111],51:[0,.64444,.13167,0,.59111],52:[.19444,.64444,.13167,0,.59111],53:[0,.64444,.13167,0,.59111],54:[0,.64444,.13167,0,.59111],55:[.19444,.64444,.13167,0,.59111],56:[0,.64444,.13167,0,.59111],57:[0,.64444,.13167,0,.59111],58:[0,.44444,.06695,0,.35555],59:[.19444,.44444,.06695,0,.35555],61:[-.10889,.39111,.06833,0,.88555],63:[0,.69444,.11472,0,.59111],64:[0,.69444,.09208,0,.88555],65:[0,.68611,0,0,.86555],66:[0,.68611,.0992,0,.81666],67:[0,.68611,.14208,0,.82666],68:[0,.68611,.09062,0,.87555],69:[0,.68611,.11431,0,.75666],70:[0,.68611,.12903,0,.72722],71:[0,.68611,.07347,0,.89527],72:[0,.68611,.17208,0,.8961],73:[0,.68611,.15681,0,.47166],74:[0,.68611,.145,0,.61055],75:[0,.68611,.14208,0,.89499],76:[0,.68611,0,0,.69777],77:[0,.68611,.17208,0,1.07277],78:[0,.68611,.17208,0,.8961],79:[0,.68611,.09062,0,.85499],80:[0,.68611,.0992,0,.78721],81:[.19444,.68611,.09062,0,.85499],82:[0,.68611,.02559,0,.85944],83:[0,.68611,.11264,0,.64999],84:[0,.68611,.12903,0,.7961],85:[0,.68611,.17208,0,.88083],86:[0,.68611,.18625,0,.86555],87:[0,.68611,.18625,0,1.15999],88:[0,.68611,.15681,0,.86555],89:[0,.68611,.19803,0,.86555],90:[0,.68611,.14208,0,.70888],91:[.25,.75,.1875,0,.35611],93:[.25,.75,.09972,0,.35611],94:[0,.69444,.06709,0,.59111],95:[.31,.13444,.09811,0,.59111],97:[0,.44444,.09426,0,.59111],98:[0,.69444,.07861,0,.53222],99:[0,.44444,.05222,0,.53222],100:[0,.69444,.10861,0,.59111],101:[0,.44444,.085,0,.53222],102:[.19444,.69444,.21778,0,.4],103:[.19444,.44444,.105,0,.53222],104:[0,.69444,.09426,0,.59111],105:[0,.69326,.11387,0,.35555],106:[.19444,.69326,.1672,0,.35555],107:[0,.69444,.11111,0,.53222],108:[0,.69444,.10861,0,.29666],109:[0,.44444,.09426,0,.94444],110:[0,.44444,.09426,0,.64999],111:[0,.44444,.07861,0,.59111],112:[.19444,.44444,.07861,0,.59111],113:[.19444,.44444,.105,0,.53222],114:[0,.44444,.11111,0,.50167],115:[0,.44444,.08167,0,.48694],116:[0,.63492,.09639,0,.385],117:[0,.44444,.09426,0,.62055],118:[0,.44444,.11111,0,.53222],119:[0,.44444,.11111,0,.76777],120:[0,.44444,.12583,0,.56055],121:[.19444,.44444,.105,0,.56166],122:[0,.44444,.13889,0,.49055],126:[.35,.34444,.11472,0,.59111],160:[0,0,0,0,.25],168:[0,.69444,.11473,0,.59111],176:[0,.69444,0,0,.94888],184:[.17014,0,0,0,.53222],198:[0,.68611,.11431,0,1.02277],216:[.04861,.73472,.09062,0,.88555],223:[.19444,.69444,.09736,0,.665],230:[0,.44444,.085,0,.82666],248:[.09722,.54167,.09458,0,.59111],305:[0,.44444,.09426,0,.35555],338:[0,.68611,.11431,0,1.14054],339:[0,.44444,.085,0,.82666],567:[.19444,.44444,.04611,0,.385],710:[0,.69444,.06709,0,.59111],711:[0,.63194,.08271,0,.59111],713:[0,.59444,.10444,0,.59111],714:[0,.69444,.08528,0,.59111],715:[0,.69444,0,0,.59111],728:[0,.69444,.10333,0,.59111],729:[0,.69444,.12945,0,.35555],730:[0,.69444,0,0,.94888],732:[0,.69444,.11472,0,.59111],733:[0,.69444,.11472,0,.59111],915:[0,.68611,.12903,0,.69777],916:[0,.68611,0,0,.94444],920:[0,.68611,.09062,0,.88555],923:[0,.68611,0,0,.80666],926:[0,.68611,.15092,0,.76777],928:[0,.68611,.17208,0,.8961],931:[0,.68611,.11431,0,.82666],933:[0,.68611,.10778,0,.88555],934:[0,.68611,.05632,0,.82666],936:[0,.68611,.10778,0,.88555],937:[0,.68611,.0992,0,.82666],8211:[0,.44444,.09811,0,.59111],8212:[0,.44444,.09811,0,1.18221],8216:[0,.69444,.12945,0,.35555],8217:[0,.69444,.12945,0,.35555],8220:[0,.69444,.16772,0,.62055],8221:[0,.69444,.07939,0,.62055]},"Main-Italic":{32:[0,0,0,0,.25],33:[0,.69444,.12417,0,.30667],34:[0,.69444,.06961,0,.51444],35:[.19444,.69444,.06616,0,.81777],37:[.05556,.75,.13639,0,.81777],38:[0,.69444,.09694,0,.76666],39:[0,.69444,.12417,0,.30667],40:[.25,.75,.16194,0,.40889],41:[.25,.75,.03694,0,.40889],42:[0,.75,.14917,0,.51111],43:[.05667,.56167,.03694,0,.76666],44:[.19444,.10556,0,0,.30667],45:[0,.43056,.02826,0,.35778],46:[0,.10556,0,0,.30667],47:[.25,.75,.16194,0,.51111],48:[0,.64444,.13556,0,.51111],49:[0,.64444,.13556,0,.51111],50:[0,.64444,.13556,0,.51111],51:[0,.64444,.13556,0,.51111],52:[.19444,.64444,.13556,0,.51111],53:[0,.64444,.13556,0,.51111],54:[0,.64444,.13556,0,.51111],55:[.19444,.64444,.13556,0,.51111],56:[0,.64444,.13556,0,.51111],57:[0,.64444,.13556,0,.51111],58:[0,.43056,.0582,0,.30667],59:[.19444,.43056,.0582,0,.30667],61:[-.13313,.36687,.06616,0,.76666],63:[0,.69444,.1225,0,.51111],64:[0,.69444,.09597,0,.76666],65:[0,.68333,0,0,.74333],66:[0,.68333,.10257,0,.70389],67:[0,.68333,.14528,0,.71555],68:[0,.68333,.09403,0,.755],69:[0,.68333,.12028,0,.67833],70:[0,.68333,.13305,0,.65277],71:[0,.68333,.08722,0,.77361],72:[0,.68333,.16389,0,.74333],73:[0,.68333,.15806,0,.38555],74:[0,.68333,.14028,0,.525],75:[0,.68333,.14528,0,.76888],76:[0,.68333,0,0,.62722],77:[0,.68333,.16389,0,.89666],78:[0,.68333,.16389,0,.74333],79:[0,.68333,.09403,0,.76666],80:[0,.68333,.10257,0,.67833],81:[.19444,.68333,.09403,0,.76666],82:[0,.68333,.03868,0,.72944],83:[0,.68333,.11972,0,.56222],84:[0,.68333,.13305,0,.71555],85:[0,.68333,.16389,0,.74333],86:[0,.68333,.18361,0,.74333],87:[0,.68333,.18361,0,.99888],88:[0,.68333,.15806,0,.74333],89:[0,.68333,.19383,0,.74333],90:[0,.68333,.14528,0,.61333],91:[.25,.75,.1875,0,.30667],93:[.25,.75,.10528,0,.30667],94:[0,.69444,.06646,0,.51111],95:[.31,.12056,.09208,0,.51111],97:[0,.43056,.07671,0,.51111],98:[0,.69444,.06312,0,.46],99:[0,.43056,.05653,0,.46],100:[0,.69444,.10333,0,.51111],101:[0,.43056,.07514,0,.46],102:[.19444,.69444,.21194,0,.30667],103:[.19444,.43056,.08847,0,.46],104:[0,.69444,.07671,0,.51111],105:[0,.65536,.1019,0,.30667],106:[.19444,.65536,.14467,0,.30667],107:[0,.69444,.10764,0,.46],108:[0,.69444,.10333,0,.25555],109:[0,.43056,.07671,0,.81777],110:[0,.43056,.07671,0,.56222],111:[0,.43056,.06312,0,.51111],112:[.19444,.43056,.06312,0,.51111],113:[.19444,.43056,.08847,0,.46],114:[0,.43056,.10764,0,.42166],115:[0,.43056,.08208,0,.40889],116:[0,.61508,.09486,0,.33222],117:[0,.43056,.07671,0,.53666],118:[0,.43056,.10764,0,.46],119:[0,.43056,.10764,0,.66444],120:[0,.43056,.12042,0,.46389],121:[.19444,.43056,.08847,0,.48555],122:[0,.43056,.12292,0,.40889],126:[.35,.31786,.11585,0,.51111],160:[0,0,0,0,.25],168:[0,.66786,.10474,0,.51111],176:[0,.69444,0,0,.83129],184:[.17014,0,0,0,.46],198:[0,.68333,.12028,0,.88277],216:[.04861,.73194,.09403,0,.76666],223:[.19444,.69444,.10514,0,.53666],230:[0,.43056,.07514,0,.71555],248:[.09722,.52778,.09194,0,.51111],338:[0,.68333,.12028,0,.98499],339:[0,.43056,.07514,0,.71555],710:[0,.69444,.06646,0,.51111],711:[0,.62847,.08295,0,.51111],713:[0,.56167,.10333,0,.51111],714:[0,.69444,.09694,0,.51111],715:[0,.69444,0,0,.51111],728:[0,.69444,.10806,0,.51111],729:[0,.66786,.11752,0,.30667],730:[0,.69444,0,0,.83129],732:[0,.66786,.11585,0,.51111],733:[0,.69444,.1225,0,.51111],915:[0,.68333,.13305,0,.62722],916:[0,.68333,0,0,.81777],920:[0,.68333,.09403,0,.76666],923:[0,.68333,0,0,.69222],926:[0,.68333,.15294,0,.66444],928:[0,.68333,.16389,0,.74333],931:[0,.68333,.12028,0,.71555],933:[0,.68333,.11111,0,.76666],934:[0,.68333,.05986,0,.71555],936:[0,.68333,.11111,0,.76666],937:[0,.68333,.10257,0,.71555],8211:[0,.43056,.09208,0,.51111],8212:[0,.43056,.09208,0,1.02222],8216:[0,.69444,.12417,0,.30667],8217:[0,.69444,.12417,0,.30667],8220:[0,.69444,.1685,0,.51444],8221:[0,.69444,.06961,0,.51444],8463:[0,.68889,0,0,.54028]},"Main-Regular":{32:[0,0,0,0,.25],33:[0,.69444,0,0,.27778],34:[0,.69444,0,0,.5],35:[.19444,.69444,0,0,.83334],36:[.05556,.75,0,0,.5],37:[.05556,.75,0,0,.83334],38:[0,.69444,0,0,.77778],39:[0,.69444,0,0,.27778],40:[.25,.75,0,0,.38889],41:[.25,.75,0,0,.38889],42:[0,.75,0,0,.5],43:[.08333,.58333,0,0,.77778],44:[.19444,.10556,0,0,.27778],45:[0,.43056,0,0,.33333],46:[0,.10556,0,0,.27778],47:[.25,.75,0,0,.5],48:[0,.64444,0,0,.5],49:[0,.64444,0,0,.5],50:[0,.64444,0,0,.5],51:[0,.64444,0,0,.5],52:[0,.64444,0,0,.5],53:[0,.64444,0,0,.5],54:[0,.64444,0,0,.5],55:[0,.64444,0,0,.5],56:[0,.64444,0,0,.5],57:[0,.64444,0,0,.5],58:[0,.43056,0,0,.27778],59:[.19444,.43056,0,0,.27778],60:[.0391,.5391,0,0,.77778],61:[-.13313,.36687,0,0,.77778],62:[.0391,.5391,0,0,.77778],63:[0,.69444,0,0,.47222],64:[0,.69444,0,0,.77778],65:[0,.68333,0,0,.75],66:[0,.68333,0,0,.70834],67:[0,.68333,0,0,.72222],68:[0,.68333,0,0,.76389],69:[0,.68333,0,0,.68056],70:[0,.68333,0,0,.65278],71:[0,.68333,0,0,.78472],72:[0,.68333,0,0,.75],73:[0,.68333,0,0,.36111],74:[0,.68333,0,0,.51389],75:[0,.68333,0,0,.77778],76:[0,.68333,0,0,.625],77:[0,.68333,0,0,.91667],78:[0,.68333,0,0,.75],79:[0,.68333,0,0,.77778],80:[0,.68333,0,0,.68056],81:[.19444,.68333,0,0,.77778],82:[0,.68333,0,0,.73611],83:[0,.68333,0,0,.55556],84:[0,.68333,0,0,.72222],85:[0,.68333,0,0,.75],86:[0,.68333,.01389,0,.75],87:[0,.68333,.01389,0,1.02778],88:[0,.68333,0,0,.75],89:[0,.68333,.025,0,.75],90:[0,.68333,0,0,.61111],91:[.25,.75,0,0,.27778],92:[.25,.75,0,0,.5],93:[.25,.75,0,0,.27778],94:[0,.69444,0,0,.5],95:[.31,.12056,.02778,0,.5],97:[0,.43056,0,0,.5],98:[0,.69444,0,0,.55556],99:[0,.43056,0,0,.44445],100:[0,.69444,0,0,.55556],101:[0,.43056,0,0,.44445],102:[0,.69444,.07778,0,.30556],103:[.19444,.43056,.01389,0,.5],104:[0,.69444,0,0,.55556],105:[0,.66786,0,0,.27778],106:[.19444,.66786,0,0,.30556],107:[0,.69444,0,0,.52778],108:[0,.69444,0,0,.27778],109:[0,.43056,0,0,.83334],110:[0,.43056,0,0,.55556],111:[0,.43056,0,0,.5],112:[.19444,.43056,0,0,.55556],113:[.19444,.43056,0,0,.52778],114:[0,.43056,0,0,.39167],115:[0,.43056,0,0,.39445],116:[0,.61508,0,0,.38889],117:[0,.43056,0,0,.55556],118:[0,.43056,.01389,0,.52778],119:[0,.43056,.01389,0,.72222],120:[0,.43056,0,0,.52778],121:[.19444,.43056,.01389,0,.52778],122:[0,.43056,0,0,.44445],123:[.25,.75,0,0,.5],124:[.25,.75,0,0,.27778],125:[.25,.75,0,0,.5],126:[.35,.31786,0,0,.5],160:[0,0,0,0,.25],163:[0,.69444,0,0,.76909],167:[.19444,.69444,0,0,.44445],168:[0,.66786,0,0,.5],172:[0,.43056,0,0,.66667],176:[0,.69444,0,0,.75],177:[.08333,.58333,0,0,.77778],182:[.19444,.69444,0,0,.61111],184:[.17014,0,0,0,.44445],198:[0,.68333,0,0,.90278],215:[.08333,.58333,0,0,.77778],216:[.04861,.73194,0,0,.77778],223:[0,.69444,0,0,.5],230:[0,.43056,0,0,.72222],247:[.08333,.58333,0,0,.77778],248:[.09722,.52778,0,0,.5],305:[0,.43056,0,0,.27778],338:[0,.68333,0,0,1.01389],339:[0,.43056,0,0,.77778],567:[.19444,.43056,0,0,.30556],710:[0,.69444,0,0,.5],711:[0,.62847,0,0,.5],713:[0,.56778,0,0,.5],714:[0,.69444,0,0,.5],715:[0,.69444,0,0,.5],728:[0,.69444,0,0,.5],729:[0,.66786,0,0,.27778],730:[0,.69444,0,0,.75],732:[0,.66786,0,0,.5],733:[0,.69444,0,0,.5],915:[0,.68333,0,0,.625],916:[0,.68333,0,0,.83334],920:[0,.68333,0,0,.77778],923:[0,.68333,0,0,.69445],926:[0,.68333,0,0,.66667],928:[0,.68333,0,0,.75],931:[0,.68333,0,0,.72222],933:[0,.68333,0,0,.77778],934:[0,.68333,0,0,.72222],936:[0,.68333,0,0,.77778],937:[0,.68333,0,0,.72222],8211:[0,.43056,.02778,0,.5],8212:[0,.43056,.02778,0,1],8216:[0,.69444,0,0,.27778],8217:[0,.69444,0,0,.27778],8220:[0,.69444,0,0,.5],8221:[0,.69444,0,0,.5],8224:[.19444,.69444,0,0,.44445],8225:[.19444,.69444,0,0,.44445],8230:[0,.123,0,0,1.172],8242:[0,.55556,0,0,.275],8407:[0,.71444,.15382,0,.5],8463:[0,.68889,0,0,.54028],8465:[0,.69444,0,0,.72222],8467:[0,.69444,0,.11111,.41667],8472:[.19444,.43056,0,.11111,.63646],8476:[0,.69444,0,0,.72222],8501:[0,.69444,0,0,.61111],8592:[-.13313,.36687,0,0,1],8593:[.19444,.69444,0,0,.5],8594:[-.13313,.36687,0,0,1],8595:[.19444,.69444,0,0,.5],8596:[-.13313,.36687,0,0,1],8597:[.25,.75,0,0,.5],8598:[.19444,.69444,0,0,1],8599:[.19444,.69444,0,0,1],8600:[.19444,.69444,0,0,1],8601:[.19444,.69444,0,0,1],8614:[.011,.511,0,0,1],8617:[.011,.511,0,0,1.126],8618:[.011,.511,0,0,1.126],8636:[-.13313,.36687,0,0,1],8637:[-.13313,.36687,0,0,1],8640:[-.13313,.36687,0,0,1],8641:[-.13313,.36687,0,0,1],8652:[.011,.671,0,0,1],8656:[-.13313,.36687,0,0,1],8657:[.19444,.69444,0,0,.61111],8658:[-.13313,.36687,0,0,1],8659:[.19444,.69444,0,0,.61111],8660:[-.13313,.36687,0,0,1],8661:[.25,.75,0,0,.61111],8704:[0,.69444,0,0,.55556],8706:[0,.69444,.05556,.08334,.5309],8707:[0,.69444,0,0,.55556],8709:[.05556,.75,0,0,.5],8711:[0,.68333,0,0,.83334],8712:[.0391,.5391,0,0,.66667],8715:[.0391,.5391,0,0,.66667],8722:[.08333,.58333,0,0,.77778],8723:[.08333,.58333,0,0,.77778],8725:[.25,.75,0,0,.5],8726:[.25,.75,0,0,.5],8727:[-.03472,.46528,0,0,.5],8728:[-.05555,.44445,0,0,.5],8729:[-.05555,.44445,0,0,.5],8730:[.2,.8,0,0,.83334],8733:[0,.43056,0,0,.77778],8734:[0,.43056,0,0,1],8736:[0,.69224,0,0,.72222],8739:[.25,.75,0,0,.27778],8741:[.25,.75,0,0,.5],8743:[0,.55556,0,0,.66667],8744:[0,.55556,0,0,.66667],8745:[0,.55556,0,0,.66667],8746:[0,.55556,0,0,.66667],8747:[.19444,.69444,.11111,0,.41667],8764:[-.13313,.36687,0,0,.77778],8768:[.19444,.69444,0,0,.27778],8771:[-.03625,.46375,0,0,.77778],8773:[-.022,.589,0,0,.778],8776:[-.01688,.48312,0,0,.77778],8781:[-.03625,.46375,0,0,.77778],8784:[-.133,.673,0,0,.778],8801:[-.03625,.46375,0,0,.77778],8804:[.13597,.63597,0,0,.77778],8805:[.13597,.63597,0,0,.77778],8810:[.0391,.5391,0,0,1],8811:[.0391,.5391,0,0,1],8826:[.0391,.5391,0,0,.77778],8827:[.0391,.5391,0,0,.77778],8834:[.0391,.5391,0,0,.77778],8835:[.0391,.5391,0,0,.77778],8838:[.13597,.63597,0,0,.77778],8839:[.13597,.63597,0,0,.77778],8846:[0,.55556,0,0,.66667],8849:[.13597,.63597,0,0,.77778],8850:[.13597,.63597,0,0,.77778],8851:[0,.55556,0,0,.66667],8852:[0,.55556,0,0,.66667],8853:[.08333,.58333,0,0,.77778],8854:[.08333,.58333,0,0,.77778],8855:[.08333,.58333,0,0,.77778],8856:[.08333,.58333,0,0,.77778],8857:[.08333,.58333,0,0,.77778],8866:[0,.69444,0,0,.61111],8867:[0,.69444,0,0,.61111],8868:[0,.69444,0,0,.77778],8869:[0,.69444,0,0,.77778],8872:[.249,.75,0,0,.867],8900:[-.05555,.44445,0,0,.5],8901:[-.05555,.44445,0,0,.27778],8902:[-.03472,.46528,0,0,.5],8904:[.005,.505,0,0,.9],8942:[.03,.903,0,0,.278],8943:[-.19,.313,0,0,1.172],8945:[-.1,.823,0,0,1.282],8968:[.25,.75,0,0,.44445],8969:[.25,.75,0,0,.44445],8970:[.25,.75,0,0,.44445],8971:[.25,.75,0,0,.44445],8994:[-.14236,.35764,0,0,1],8995:[-.14236,.35764,0,0,1],9136:[.244,.744,0,0,.412],9137:[.244,.745,0,0,.412],9651:[.19444,.69444,0,0,.88889],9657:[-.03472,.46528,0,0,.5],9661:[.19444,.69444,0,0,.88889],9667:[-.03472,.46528,0,0,.5],9711:[.19444,.69444,0,0,1],9824:[.12963,.69444,0,0,.77778],9825:[.12963,.69444,0,0,.77778],9826:[.12963,.69444,0,0,.77778],9827:[.12963,.69444,0,0,.77778],9837:[0,.75,0,0,.38889],9838:[.19444,.69444,0,0,.38889],9839:[.19444,.69444,0,0,.38889],10216:[.25,.75,0,0,.38889],10217:[.25,.75,0,0,.38889],10222:[.244,.744,0,0,.412],10223:[.244,.745,0,0,.412],10229:[.011,.511,0,0,1.609],10230:[.011,.511,0,0,1.638],10231:[.011,.511,0,0,1.859],10232:[.024,.525,0,0,1.609],10233:[.024,.525,0,0,1.638],10234:[.024,.525,0,0,1.858],10236:[.011,.511,0,0,1.638],10815:[0,.68333,0,0,.75],10927:[.13597,.63597,0,0,.77778],10928:[.13597,.63597,0,0,.77778],57376:[.19444,.69444,0,0,0]},"Math-BoldItalic":{32:[0,0,0,0,.25],48:[0,.44444,0,0,.575],49:[0,.44444,0,0,.575],50:[0,.44444,0,0,.575],51:[.19444,.44444,0,0,.575],52:[.19444,.44444,0,0,.575],53:[.19444,.44444,0,0,.575],54:[0,.64444,0,0,.575],55:[.19444,.44444,0,0,.575],56:[0,.64444,0,0,.575],57:[.19444,.44444,0,0,.575],65:[0,.68611,0,0,.86944],66:[0,.68611,.04835,0,.8664],67:[0,.68611,.06979,0,.81694],68:[0,.68611,.03194,0,.93812],69:[0,.68611,.05451,0,.81007],70:[0,.68611,.15972,0,.68889],71:[0,.68611,0,0,.88673],72:[0,.68611,.08229,0,.98229],73:[0,.68611,.07778,0,.51111],74:[0,.68611,.10069,0,.63125],75:[0,.68611,.06979,0,.97118],76:[0,.68611,0,0,.75555],77:[0,.68611,.11424,0,1.14201],78:[0,.68611,.11424,0,.95034],79:[0,.68611,.03194,0,.83666],80:[0,.68611,.15972,0,.72309],81:[.19444,.68611,0,0,.86861],82:[0,.68611,.00421,0,.87235],83:[0,.68611,.05382,0,.69271],84:[0,.68611,.15972,0,.63663],85:[0,.68611,.11424,0,.80027],86:[0,.68611,.25555,0,.67778],87:[0,.68611,.15972,0,1.09305],88:[0,.68611,.07778,0,.94722],89:[0,.68611,.25555,0,.67458],90:[0,.68611,.06979,0,.77257],97:[0,.44444,0,0,.63287],98:[0,.69444,0,0,.52083],99:[0,.44444,0,0,.51342],100:[0,.69444,0,0,.60972],101:[0,.44444,0,0,.55361],102:[.19444,.69444,.11042,0,.56806],103:[.19444,.44444,.03704,0,.5449],104:[0,.69444,0,0,.66759],105:[0,.69326,0,0,.4048],106:[.19444,.69326,.0622,0,.47083],107:[0,.69444,.01852,0,.6037],108:[0,.69444,.0088,0,.34815],109:[0,.44444,0,0,1.0324],110:[0,.44444,0,0,.71296],111:[0,.44444,0,0,.58472],112:[.19444,.44444,0,0,.60092],113:[.19444,.44444,.03704,0,.54213],114:[0,.44444,.03194,0,.5287],115:[0,.44444,0,0,.53125],116:[0,.63492,0,0,.41528],117:[0,.44444,0,0,.68102],118:[0,.44444,.03704,0,.56666],119:[0,.44444,.02778,0,.83148],120:[0,.44444,0,0,.65903],121:[.19444,.44444,.03704,0,.59028],122:[0,.44444,.04213,0,.55509],160:[0,0,0,0,.25],915:[0,.68611,.15972,0,.65694],916:[0,.68611,0,0,.95833],920:[0,.68611,.03194,0,.86722],923:[0,.68611,0,0,.80555],926:[0,.68611,.07458,0,.84125],928:[0,.68611,.08229,0,.98229],931:[0,.68611,.05451,0,.88507],933:[0,.68611,.15972,0,.67083],934:[0,.68611,0,0,.76666],936:[0,.68611,.11653,0,.71402],937:[0,.68611,.04835,0,.8789],945:[0,.44444,0,0,.76064],946:[.19444,.69444,.03403,0,.65972],947:[.19444,.44444,.06389,0,.59003],948:[0,.69444,.03819,0,.52222],949:[0,.44444,0,0,.52882],950:[.19444,.69444,.06215,0,.50833],951:[.19444,.44444,.03704,0,.6],952:[0,.69444,.03194,0,.5618],953:[0,.44444,0,0,.41204],954:[0,.44444,0,0,.66759],955:[0,.69444,0,0,.67083],956:[.19444,.44444,0,0,.70787],957:[0,.44444,.06898,0,.57685],958:[.19444,.69444,.03021,0,.50833],959:[0,.44444,0,0,.58472],960:[0,.44444,.03704,0,.68241],961:[.19444,.44444,0,0,.6118],962:[.09722,.44444,.07917,0,.42361],963:[0,.44444,.03704,0,.68588],964:[0,.44444,.13472,0,.52083],965:[0,.44444,.03704,0,.63055],966:[.19444,.44444,0,0,.74722],967:[.19444,.44444,0,0,.71805],968:[.19444,.69444,.03704,0,.75833],969:[0,.44444,.03704,0,.71782],977:[0,.69444,0,0,.69155],981:[.19444,.69444,0,0,.7125],982:[0,.44444,.03194,0,.975],1009:[.19444,.44444,0,0,.6118],1013:[0,.44444,0,0,.48333],57649:[0,.44444,0,0,.39352],57911:[.19444,.44444,0,0,.43889]},"Math-Italic":{32:[0,0,0,0,.25],48:[0,.43056,0,0,.5],49:[0,.43056,0,0,.5],50:[0,.43056,0,0,.5],51:[.19444,.43056,0,0,.5],52:[.19444,.43056,0,0,.5],53:[.19444,.43056,0,0,.5],54:[0,.64444,0,0,.5],55:[.19444,.43056,0,0,.5],56:[0,.64444,0,0,.5],57:[.19444,.43056,0,0,.5],65:[0,.68333,0,.13889,.75],66:[0,.68333,.05017,.08334,.75851],67:[0,.68333,.07153,.08334,.71472],68:[0,.68333,.02778,.05556,.82792],69:[0,.68333,.05764,.08334,.7382],70:[0,.68333,.13889,.08334,.64306],71:[0,.68333,0,.08334,.78625],72:[0,.68333,.08125,.05556,.83125],73:[0,.68333,.07847,.11111,.43958],74:[0,.68333,.09618,.16667,.55451],75:[0,.68333,.07153,.05556,.84931],76:[0,.68333,0,.02778,.68056],77:[0,.68333,.10903,.08334,.97014],78:[0,.68333,.10903,.08334,.80347],79:[0,.68333,.02778,.08334,.76278],80:[0,.68333,.13889,.08334,.64201],81:[.19444,.68333,0,.08334,.79056],82:[0,.68333,.00773,.08334,.75929],83:[0,.68333,.05764,.08334,.6132],84:[0,.68333,.13889,.08334,.58438],85:[0,.68333,.10903,.02778,.68278],86:[0,.68333,.22222,0,.58333],87:[0,.68333,.13889,0,.94445],88:[0,.68333,.07847,.08334,.82847],89:[0,.68333,.22222,0,.58056],90:[0,.68333,.07153,.08334,.68264],97:[0,.43056,0,0,.52859],98:[0,.69444,0,0,.42917],99:[0,.43056,0,.05556,.43276],100:[0,.69444,0,.16667,.52049],101:[0,.43056,0,.05556,.46563],102:[.19444,.69444,.10764,.16667,.48959],103:[.19444,.43056,.03588,.02778,.47697],104:[0,.69444,0,0,.57616],105:[0,.65952,0,0,.34451],106:[.19444,.65952,.05724,0,.41181],107:[0,.69444,.03148,0,.5206],108:[0,.69444,.01968,.08334,.29838],109:[0,.43056,0,0,.87801],110:[0,.43056,0,0,.60023],111:[0,.43056,0,.05556,.48472],112:[.19444,.43056,0,.08334,.50313],113:[.19444,.43056,.03588,.08334,.44641],114:[0,.43056,.02778,.05556,.45116],115:[0,.43056,0,.05556,.46875],116:[0,.61508,0,.08334,.36111],117:[0,.43056,0,.02778,.57246],118:[0,.43056,.03588,.02778,.48472],119:[0,.43056,.02691,.08334,.71592],120:[0,.43056,0,.02778,.57153],121:[.19444,.43056,.03588,.05556,.49028],122:[0,.43056,.04398,.05556,.46505],160:[0,0,0,0,.25],915:[0,.68333,.13889,.08334,.61528],916:[0,.68333,0,.16667,.83334],920:[0,.68333,.02778,.08334,.76278],923:[0,.68333,0,.16667,.69445],926:[0,.68333,.07569,.08334,.74236],928:[0,.68333,.08125,.05556,.83125],931:[0,.68333,.05764,.08334,.77986],933:[0,.68333,.13889,.05556,.58333],934:[0,.68333,0,.08334,.66667],936:[0,.68333,.11,.05556,.61222],937:[0,.68333,.05017,.08334,.7724],945:[0,.43056,.0037,.02778,.6397],946:[.19444,.69444,.05278,.08334,.56563],947:[.19444,.43056,.05556,0,.51773],948:[0,.69444,.03785,.05556,.44444],949:[0,.43056,0,.08334,.46632],950:[.19444,.69444,.07378,.08334,.4375],951:[.19444,.43056,.03588,.05556,.49653],952:[0,.69444,.02778,.08334,.46944],953:[0,.43056,0,.05556,.35394],954:[0,.43056,0,0,.57616],955:[0,.69444,0,0,.58334],956:[.19444,.43056,0,.02778,.60255],957:[0,.43056,.06366,.02778,.49398],958:[.19444,.69444,.04601,.11111,.4375],959:[0,.43056,0,.05556,.48472],960:[0,.43056,.03588,0,.57003],961:[.19444,.43056,0,.08334,.51702],962:[.09722,.43056,.07986,.08334,.36285],963:[0,.43056,.03588,0,.57141],964:[0,.43056,.1132,.02778,.43715],965:[0,.43056,.03588,.02778,.54028],966:[.19444,.43056,0,.08334,.65417],967:[.19444,.43056,0,.05556,.62569],968:[.19444,.69444,.03588,.11111,.65139],969:[0,.43056,.03588,0,.62245],977:[0,.69444,0,.08334,.59144],981:[.19444,.69444,0,.08334,.59583],982:[0,.43056,.02778,0,.82813],1009:[.19444,.43056,0,.08334,.51702],1013:[0,.43056,0,.05556,.4059],57649:[0,.43056,0,.02778,.32246],57911:[.19444,.43056,0,.08334,.38403]},"SansSerif-Bold":{32:[0,0,0,0,.25],33:[0,.69444,0,0,.36667],34:[0,.69444,0,0,.55834],35:[.19444,.69444,0,0,.91667],36:[.05556,.75,0,0,.55],37:[.05556,.75,0,0,1.02912],38:[0,.69444,0,0,.83056],39:[0,.69444,0,0,.30556],40:[.25,.75,0,0,.42778],41:[.25,.75,0,0,.42778],42:[0,.75,0,0,.55],43:[.11667,.61667,0,0,.85556],44:[.10556,.13056,0,0,.30556],45:[0,.45833,0,0,.36667],46:[0,.13056,0,0,.30556],47:[.25,.75,0,0,.55],48:[0,.69444,0,0,.55],49:[0,.69444,0,0,.55],50:[0,.69444,0,0,.55],51:[0,.69444,0,0,.55],52:[0,.69444,0,0,.55],53:[0,.69444,0,0,.55],54:[0,.69444,0,0,.55],55:[0,.69444,0,0,.55],56:[0,.69444,0,0,.55],57:[0,.69444,0,0,.55],58:[0,.45833,0,0,.30556],59:[.10556,.45833,0,0,.30556],61:[-.09375,.40625,0,0,.85556],63:[0,.69444,0,0,.51945],64:[0,.69444,0,0,.73334],65:[0,.69444,0,0,.73334],66:[0,.69444,0,0,.73334],67:[0,.69444,0,0,.70278],68:[0,.69444,0,0,.79445],69:[0,.69444,0,0,.64167],70:[0,.69444,0,0,.61111],71:[0,.69444,0,0,.73334],72:[0,.69444,0,0,.79445],73:[0,.69444,0,0,.33056],74:[0,.69444,0,0,.51945],75:[0,.69444,0,0,.76389],76:[0,.69444,0,0,.58056],77:[0,.69444,0,0,.97778],78:[0,.69444,0,0,.79445],79:[0,.69444,0,0,.79445],80:[0,.69444,0,0,.70278],81:[.10556,.69444,0,0,.79445],82:[0,.69444,0,0,.70278],83:[0,.69444,0,0,.61111],84:[0,.69444,0,0,.73334],85:[0,.69444,0,0,.76389],86:[0,.69444,.01528,0,.73334],87:[0,.69444,.01528,0,1.03889],88:[0,.69444,0,0,.73334],89:[0,.69444,.0275,0,.73334],90:[0,.69444,0,0,.67223],91:[.25,.75,0,0,.34306],93:[.25,.75,0,0,.34306],94:[0,.69444,0,0,.55],95:[.35,.10833,.03056,0,.55],97:[0,.45833,0,0,.525],98:[0,.69444,0,0,.56111],99:[0,.45833,0,0,.48889],100:[0,.69444,0,0,.56111],101:[0,.45833,0,0,.51111],102:[0,.69444,.07639,0,.33611],103:[.19444,.45833,.01528,0,.55],104:[0,.69444,0,0,.56111],105:[0,.69444,0,0,.25556],106:[.19444,.69444,0,0,.28611],107:[0,.69444,0,0,.53056],108:[0,.69444,0,0,.25556],109:[0,.45833,0,0,.86667],110:[0,.45833,0,0,.56111],111:[0,.45833,0,0,.55],112:[.19444,.45833,0,0,.56111],113:[.19444,.45833,0,0,.56111],114:[0,.45833,.01528,0,.37222],115:[0,.45833,0,0,.42167],116:[0,.58929,0,0,.40417],117:[0,.45833,0,0,.56111],118:[0,.45833,.01528,0,.5],119:[0,.45833,.01528,0,.74445],120:[0,.45833,0,0,.5],121:[.19444,.45833,.01528,0,.5],122:[0,.45833,0,0,.47639],126:[.35,.34444,0,0,.55],160:[0,0,0,0,.25],168:[0,.69444,0,0,.55],176:[0,.69444,0,0,.73334],180:[0,.69444,0,0,.55],184:[.17014,0,0,0,.48889],305:[0,.45833,0,0,.25556],567:[.19444,.45833,0,0,.28611],710:[0,.69444,0,0,.55],711:[0,.63542,0,0,.55],713:[0,.63778,0,0,.55],728:[0,.69444,0,0,.55],729:[0,.69444,0,0,.30556],730:[0,.69444,0,0,.73334],732:[0,.69444,0,0,.55],733:[0,.69444,0,0,.55],915:[0,.69444,0,0,.58056],916:[0,.69444,0,0,.91667],920:[0,.69444,0,0,.85556],923:[0,.69444,0,0,.67223],926:[0,.69444,0,0,.73334],928:[0,.69444,0,0,.79445],931:[0,.69444,0,0,.79445],933:[0,.69444,0,0,.85556],934:[0,.69444,0,0,.79445],936:[0,.69444,0,0,.85556],937:[0,.69444,0,0,.79445],8211:[0,.45833,.03056,0,.55],8212:[0,.45833,.03056,0,1.10001],8216:[0,.69444,0,0,.30556],8217:[0,.69444,0,0,.30556],8220:[0,.69444,0,0,.55834],8221:[0,.69444,0,0,.55834]},"SansSerif-Italic":{32:[0,0,0,0,.25],33:[0,.69444,.05733,0,.31945],34:[0,.69444,.00316,0,.5],35:[.19444,.69444,.05087,0,.83334],36:[.05556,.75,.11156,0,.5],37:[.05556,.75,.03126,0,.83334],38:[0,.69444,.03058,0,.75834],39:[0,.69444,.07816,0,.27778],40:[.25,.75,.13164,0,.38889],41:[.25,.75,.02536,0,.38889],42:[0,.75,.11775,0,.5],43:[.08333,.58333,.02536,0,.77778],44:[.125,.08333,0,0,.27778],45:[0,.44444,.01946,0,.33333],46:[0,.08333,0,0,.27778],47:[.25,.75,.13164,0,.5],48:[0,.65556,.11156,0,.5],49:[0,.65556,.11156,0,.5],50:[0,.65556,.11156,0,.5],51:[0,.65556,.11156,0,.5],52:[0,.65556,.11156,0,.5],53:[0,.65556,.11156,0,.5],54:[0,.65556,.11156,0,.5],55:[0,.65556,.11156,0,.5],56:[0,.65556,.11156,0,.5],57:[0,.65556,.11156,0,.5],58:[0,.44444,.02502,0,.27778],59:[.125,.44444,.02502,0,.27778],61:[-.13,.37,.05087,0,.77778],63:[0,.69444,.11809,0,.47222],64:[0,.69444,.07555,0,.66667],65:[0,.69444,0,0,.66667],66:[0,.69444,.08293,0,.66667],67:[0,.69444,.11983,0,.63889],68:[0,.69444,.07555,0,.72223],69:[0,.69444,.11983,0,.59722],70:[0,.69444,.13372,0,.56945],71:[0,.69444,.11983,0,.66667],72:[0,.69444,.08094,0,.70834],73:[0,.69444,.13372,0,.27778],74:[0,.69444,.08094,0,.47222],75:[0,.69444,.11983,0,.69445],76:[0,.69444,0,0,.54167],77:[0,.69444,.08094,0,.875],78:[0,.69444,.08094,0,.70834],79:[0,.69444,.07555,0,.73611],80:[0,.69444,.08293,0,.63889],81:[.125,.69444,.07555,0,.73611],82:[0,.69444,.08293,0,.64584],83:[0,.69444,.09205,0,.55556],84:[0,.69444,.13372,0,.68056],85:[0,.69444,.08094,0,.6875],86:[0,.69444,.1615,0,.66667],87:[0,.69444,.1615,0,.94445],88:[0,.69444,.13372,0,.66667],89:[0,.69444,.17261,0,.66667],90:[0,.69444,.11983,0,.61111],91:[.25,.75,.15942,0,.28889],93:[.25,.75,.08719,0,.28889],94:[0,.69444,.0799,0,.5],95:[.35,.09444,.08616,0,.5],97:[0,.44444,.00981,0,.48056],98:[0,.69444,.03057,0,.51667],99:[0,.44444,.08336,0,.44445],100:[0,.69444,.09483,0,.51667],101:[0,.44444,.06778,0,.44445],102:[0,.69444,.21705,0,.30556],103:[.19444,.44444,.10836,0,.5],104:[0,.69444,.01778,0,.51667],105:[0,.67937,.09718,0,.23889],106:[.19444,.67937,.09162,0,.26667],107:[0,.69444,.08336,0,.48889],108:[0,.69444,.09483,0,.23889],109:[0,.44444,.01778,0,.79445],110:[0,.44444,.01778,0,.51667],111:[0,.44444,.06613,0,.5],112:[.19444,.44444,.0389,0,.51667],113:[.19444,.44444,.04169,0,.51667],114:[0,.44444,.10836,0,.34167],115:[0,.44444,.0778,0,.38333],116:[0,.57143,.07225,0,.36111],117:[0,.44444,.04169,0,.51667],118:[0,.44444,.10836,0,.46111],119:[0,.44444,.10836,0,.68334],120:[0,.44444,.09169,0,.46111],121:[.19444,.44444,.10836,0,.46111],122:[0,.44444,.08752,0,.43472],126:[.35,.32659,.08826,0,.5],160:[0,0,0,0,.25],168:[0,.67937,.06385,0,.5],176:[0,.69444,0,0,.73752],184:[.17014,0,0,0,.44445],305:[0,.44444,.04169,0,.23889],567:[.19444,.44444,.04169,0,.26667],710:[0,.69444,.0799,0,.5],711:[0,.63194,.08432,0,.5],713:[0,.60889,.08776,0,.5],714:[0,.69444,.09205,0,.5],715:[0,.69444,0,0,.5],728:[0,.69444,.09483,0,.5],729:[0,.67937,.07774,0,.27778],730:[0,.69444,0,0,.73752],732:[0,.67659,.08826,0,.5],733:[0,.69444,.09205,0,.5],915:[0,.69444,.13372,0,.54167],916:[0,.69444,0,0,.83334],920:[0,.69444,.07555,0,.77778],923:[0,.69444,0,0,.61111],926:[0,.69444,.12816,0,.66667],928:[0,.69444,.08094,0,.70834],931:[0,.69444,.11983,0,.72222],933:[0,.69444,.09031,0,.77778],934:[0,.69444,.04603,0,.72222],936:[0,.69444,.09031,0,.77778],937:[0,.69444,.08293,0,.72222],8211:[0,.44444,.08616,0,.5],8212:[0,.44444,.08616,0,1],8216:[0,.69444,.07816,0,.27778],8217:[0,.69444,.07816,0,.27778],8220:[0,.69444,.14205,0,.5],8221:[0,.69444,.00316,0,.5]},"SansSerif-Regular":{32:[0,0,0,0,.25],33:[0,.69444,0,0,.31945],34:[0,.69444,0,0,.5],35:[.19444,.69444,0,0,.83334],36:[.05556,.75,0,0,.5],37:[.05556,.75,0,0,.83334],38:[0,.69444,0,0,.75834],39:[0,.69444,0,0,.27778],40:[.25,.75,0,0,.38889],41:[.25,.75,0,0,.38889],42:[0,.75,0,0,.5],43:[.08333,.58333,0,0,.77778],44:[.125,.08333,0,0,.27778],45:[0,.44444,0,0,.33333],46:[0,.08333,0,0,.27778],47:[.25,.75,0,0,.5],48:[0,.65556,0,0,.5],49:[0,.65556,0,0,.5],50:[0,.65556,0,0,.5],51:[0,.65556,0,0,.5],52:[0,.65556,0,0,.5],53:[0,.65556,0,0,.5],54:[0,.65556,0,0,.5],55:[0,.65556,0,0,.5],56:[0,.65556,0,0,.5],57:[0,.65556,0,0,.5],58:[0,.44444,0,0,.27778],59:[.125,.44444,0,0,.27778],61:[-.13,.37,0,0,.77778],63:[0,.69444,0,0,.47222],64:[0,.69444,0,0,.66667],65:[0,.69444,0,0,.66667],66:[0,.69444,0,0,.66667],67:[0,.69444,0,0,.63889],68:[0,.69444,0,0,.72223],69:[0,.69444,0,0,.59722],70:[0,.69444,0,0,.56945],71:[0,.69444,0,0,.66667],72:[0,.69444,0,0,.70834],73:[0,.69444,0,0,.27778],74:[0,.69444,0,0,.47222],75:[0,.69444,0,0,.69445],76:[0,.69444,0,0,.54167],77:[0,.69444,0,0,.875],78:[0,.69444,0,0,.70834],79:[0,.69444,0,0,.73611],80:[0,.69444,0,0,.63889],81:[.125,.69444,0,0,.73611],82:[0,.69444,0,0,.64584],83:[0,.69444,0,0,.55556],84:[0,.69444,0,0,.68056],85:[0,.69444,0,0,.6875],86:[0,.69444,.01389,0,.66667],87:[0,.69444,.01389,0,.94445],88:[0,.69444,0,0,.66667],89:[0,.69444,.025,0,.66667],90:[0,.69444,0,0,.61111],91:[.25,.75,0,0,.28889],93:[.25,.75,0,0,.28889],94:[0,.69444,0,0,.5],95:[.35,.09444,.02778,0,.5],97:[0,.44444,0,0,.48056],98:[0,.69444,0,0,.51667],99:[0,.44444,0,0,.44445],100:[0,.69444,0,0,.51667],101:[0,.44444,0,0,.44445],102:[0,.69444,.06944,0,.30556],103:[.19444,.44444,.01389,0,.5],104:[0,.69444,0,0,.51667],105:[0,.67937,0,0,.23889],106:[.19444,.67937,0,0,.26667],107:[0,.69444,0,0,.48889],108:[0,.69444,0,0,.23889],109:[0,.44444,0,0,.79445],110:[0,.44444,0,0,.51667],111:[0,.44444,0,0,.5],112:[.19444,.44444,0,0,.51667],113:[.19444,.44444,0,0,.51667],114:[0,.44444,.01389,0,.34167],115:[0,.44444,0,0,.38333],116:[0,.57143,0,0,.36111],117:[0,.44444,0,0,.51667],118:[0,.44444,.01389,0,.46111],119:[0,.44444,.01389,0,.68334],120:[0,.44444,0,0,.46111],121:[.19444,.44444,.01389,0,.46111],122:[0,.44444,0,0,.43472],126:[.35,.32659,0,0,.5],160:[0,0,0,0,.25],168:[0,.67937,0,0,.5],176:[0,.69444,0,0,.66667],184:[.17014,0,0,0,.44445],305:[0,.44444,0,0,.23889],567:[.19444,.44444,0,0,.26667],710:[0,.69444,0,0,.5],711:[0,.63194,0,0,.5],713:[0,.60889,0,0,.5],714:[0,.69444,0,0,.5],715:[0,.69444,0,0,.5],728:[0,.69444,0,0,.5],729:[0,.67937,0,0,.27778],730:[0,.69444,0,0,.66667],732:[0,.67659,0,0,.5],733:[0,.69444,0,0,.5],915:[0,.69444,0,0,.54167],916:[0,.69444,0,0,.83334],920:[0,.69444,0,0,.77778],923:[0,.69444,0,0,.61111],926:[0,.69444,0,0,.66667],928:[0,.69444,0,0,.70834],931:[0,.69444,0,0,.72222],933:[0,.69444,0,0,.77778],934:[0,.69444,0,0,.72222],936:[0,.69444,0,0,.77778],937:[0,.69444,0,0,.72222],8211:[0,.44444,.02778,0,.5],8212:[0,.44444,.02778,0,1],8216:[0,.69444,0,0,.27778],8217:[0,.69444,0,0,.27778],8220:[0,.69444,0,0,.5],8221:[0,.69444,0,0,.5]},"Script-Regular":{32:[0,0,0,0,.25],65:[0,.7,.22925,0,.80253],66:[0,.7,.04087,0,.90757],67:[0,.7,.1689,0,.66619],68:[0,.7,.09371,0,.77443],69:[0,.7,.18583,0,.56162],70:[0,.7,.13634,0,.89544],71:[0,.7,.17322,0,.60961],72:[0,.7,.29694,0,.96919],73:[0,.7,.19189,0,.80907],74:[.27778,.7,.19189,0,1.05159],75:[0,.7,.31259,0,.91364],76:[0,.7,.19189,0,.87373],77:[0,.7,.15981,0,1.08031],78:[0,.7,.3525,0,.9015],79:[0,.7,.08078,0,.73787],80:[0,.7,.08078,0,1.01262],81:[0,.7,.03305,0,.88282],82:[0,.7,.06259,0,.85],83:[0,.7,.19189,0,.86767],84:[0,.7,.29087,0,.74697],85:[0,.7,.25815,0,.79996],86:[0,.7,.27523,0,.62204],87:[0,.7,.27523,0,.80532],88:[0,.7,.26006,0,.94445],89:[0,.7,.2939,0,.70961],90:[0,.7,.24037,0,.8212],160:[0,0,0,0,.25]},"Size1-Regular":{32:[0,0,0,0,.25],40:[.35001,.85,0,0,.45834],41:[.35001,.85,0,0,.45834],47:[.35001,.85,0,0,.57778],91:[.35001,.85,0,0,.41667],92:[.35001,.85,0,0,.57778],93:[.35001,.85,0,0,.41667],123:[.35001,.85,0,0,.58334],125:[.35001,.85,0,0,.58334],160:[0,0,0,0,.25],710:[0,.72222,0,0,.55556],732:[0,.72222,0,0,.55556],770:[0,.72222,0,0,.55556],771:[0,.72222,0,0,.55556],8214:[-99e-5,.601,0,0,.77778],8593:[1e-5,.6,0,0,.66667],8595:[1e-5,.6,0,0,.66667],8657:[1e-5,.6,0,0,.77778],8659:[1e-5,.6,0,0,.77778],8719:[.25001,.75,0,0,.94445],8720:[.25001,.75,0,0,.94445],8721:[.25001,.75,0,0,1.05556],8730:[.35001,.85,0,0,1],8739:[-.00599,.606,0,0,.33333],8741:[-.00599,.606,0,0,.55556],8747:[.30612,.805,.19445,0,.47222],8748:[.306,.805,.19445,0,.47222],8749:[.306,.805,.19445,0,.47222],8750:[.30612,.805,.19445,0,.47222],8896:[.25001,.75,0,0,.83334],8897:[.25001,.75,0,0,.83334],8898:[.25001,.75,0,0,.83334],8899:[.25001,.75,0,0,.83334],8968:[.35001,.85,0,0,.47222],8969:[.35001,.85,0,0,.47222],8970:[.35001,.85,0,0,.47222],8971:[.35001,.85,0,0,.47222],9168:[-99e-5,.601,0,0,.66667],10216:[.35001,.85,0,0,.47222],10217:[.35001,.85,0,0,.47222],10752:[.25001,.75,0,0,1.11111],10753:[.25001,.75,0,0,1.11111],10754:[.25001,.75,0,0,1.11111],10756:[.25001,.75,0,0,.83334],10758:[.25001,.75,0,0,.83334]},"Size2-Regular":{32:[0,0,0,0,.25],40:[.65002,1.15,0,0,.59722],41:[.65002,1.15,0,0,.59722],47:[.65002,1.15,0,0,.81111],91:[.65002,1.15,0,0,.47222],92:[.65002,1.15,0,0,.81111],93:[.65002,1.15,0,0,.47222],123:[.65002,1.15,0,0,.66667],125:[.65002,1.15,0,0,.66667],160:[0,0,0,0,.25],710:[0,.75,0,0,1],732:[0,.75,0,0,1],770:[0,.75,0,0,1],771:[0,.75,0,0,1],8719:[.55001,1.05,0,0,1.27778],8720:[.55001,1.05,0,0,1.27778],8721:[.55001,1.05,0,0,1.44445],8730:[.65002,1.15,0,0,1],8747:[.86225,1.36,.44445,0,.55556],8748:[.862,1.36,.44445,0,.55556],8749:[.862,1.36,.44445,0,.55556],8750:[.86225,1.36,.44445,0,.55556],8896:[.55001,1.05,0,0,1.11111],8897:[.55001,1.05,0,0,1.11111],8898:[.55001,1.05,0,0,1.11111],8899:[.55001,1.05,0,0,1.11111],8968:[.65002,1.15,0,0,.52778],8969:[.65002,1.15,0,0,.52778],8970:[.65002,1.15,0,0,.52778],8971:[.65002,1.15,0,0,.52778],10216:[.65002,1.15,0,0,.61111],10217:[.65002,1.15,0,0,.61111],10752:[.55001,1.05,0,0,1.51112],10753:[.55001,1.05,0,0,1.51112],10754:[.55001,1.05,0,0,1.51112],10756:[.55001,1.05,0,0,1.11111],10758:[.55001,1.05,0,0,1.11111]},"Size3-Regular":{32:[0,0,0,0,.25],40:[.95003,1.45,0,0,.73611],41:[.95003,1.45,0,0,.73611],47:[.95003,1.45,0,0,1.04445],91:[.95003,1.45,0,0,.52778],92:[.95003,1.45,0,0,1.04445],93:[.95003,1.45,0,0,.52778],123:[.95003,1.45,0,0,.75],125:[.95003,1.45,0,0,.75],160:[0,0,0,0,.25],710:[0,.75,0,0,1.44445],732:[0,.75,0,0,1.44445],770:[0,.75,0,0,1.44445],771:[0,.75,0,0,1.44445],8730:[.95003,1.45,0,0,1],8968:[.95003,1.45,0,0,.58334],8969:[.95003,1.45,0,0,.58334],8970:[.95003,1.45,0,0,.58334],8971:[.95003,1.45,0,0,.58334],10216:[.95003,1.45,0,0,.75],10217:[.95003,1.45,0,0,.75]},"Size4-Regular":{32:[0,0,0,0,.25],40:[1.25003,1.75,0,0,.79167],41:[1.25003,1.75,0,0,.79167],47:[1.25003,1.75,0,0,1.27778],91:[1.25003,1.75,0,0,.58334],92:[1.25003,1.75,0,0,1.27778],93:[1.25003,1.75,0,0,.58334],123:[1.25003,1.75,0,0,.80556],125:[1.25003,1.75,0,0,.80556],160:[0,0,0,0,.25],710:[0,.825,0,0,1.8889],732:[0,.825,0,0,1.8889],770:[0,.825,0,0,1.8889],771:[0,.825,0,0,1.8889],8730:[1.25003,1.75,0,0,1],8968:[1.25003,1.75,0,0,.63889],8969:[1.25003,1.75,0,0,.63889],8970:[1.25003,1.75,0,0,.63889],8971:[1.25003,1.75,0,0,.63889],9115:[.64502,1.155,0,0,.875],9116:[1e-5,.6,0,0,.875],9117:[.64502,1.155,0,0,.875],9118:[.64502,1.155,0,0,.875],9119:[1e-5,.6,0,0,.875],9120:[.64502,1.155,0,0,.875],9121:[.64502,1.155,0,0,.66667],9122:[-99e-5,.601,0,0,.66667],9123:[.64502,1.155,0,0,.66667],9124:[.64502,1.155,0,0,.66667],9125:[-99e-5,.601,0,0,.66667],9126:[.64502,1.155,0,0,.66667],9127:[1e-5,.9,0,0,.88889],9128:[.65002,1.15,0,0,.88889],9129:[.90001,0,0,0,.88889],9130:[0,.3,0,0,.88889],9131:[1e-5,.9,0,0,.88889],9132:[.65002,1.15,0,0,.88889],9133:[.90001,0,0,0,.88889],9143:[.88502,.915,0,0,1.05556],10216:[1.25003,1.75,0,0,.80556],10217:[1.25003,1.75,0,0,.80556],57344:[-.00499,.605,0,0,1.05556],57345:[-.00499,.605,0,0,1.05556],57680:[0,.12,0,0,.45],57681:[0,.12,0,0,.45],57682:[0,.12,0,0,.45],57683:[0,.12,0,0,.45]},"Typewriter-Regular":{32:[0,0,0,0,.525],33:[0,.61111,0,0,.525],34:[0,.61111,0,0,.525],35:[0,.61111,0,0,.525],36:[.08333,.69444,0,0,.525],37:[.08333,.69444,0,0,.525],38:[0,.61111,0,0,.525],39:[0,.61111,0,0,.525],40:[.08333,.69444,0,0,.525],41:[.08333,.69444,0,0,.525],42:[0,.52083,0,0,.525],43:[-.08056,.53055,0,0,.525],44:[.13889,.125,0,0,.525],45:[-.08056,.53055,0,0,.525],46:[0,.125,0,0,.525],47:[.08333,.69444,0,0,.525],48:[0,.61111,0,0,.525],49:[0,.61111,0,0,.525],50:[0,.61111,0,0,.525],51:[0,.61111,0,0,.525],52:[0,.61111,0,0,.525],53:[0,.61111,0,0,.525],54:[0,.61111,0,0,.525],55:[0,.61111,0,0,.525],56:[0,.61111,0,0,.525],57:[0,.61111,0,0,.525],58:[0,.43056,0,0,.525],59:[.13889,.43056,0,0,.525],60:[-.05556,.55556,0,0,.525],61:[-.19549,.41562,0,0,.525],62:[-.05556,.55556,0,0,.525],63:[0,.61111,0,0,.525],64:[0,.61111,0,0,.525],65:[0,.61111,0,0,.525],66:[0,.61111,0,0,.525],67:[0,.61111,0,0,.525],68:[0,.61111,0,0,.525],69:[0,.61111,0,0,.525],70:[0,.61111,0,0,.525],71:[0,.61111,0,0,.525],72:[0,.61111,0,0,.525],73:[0,.61111,0,0,.525],74:[0,.61111,0,0,.525],75:[0,.61111,0,0,.525],76:[0,.61111,0,0,.525],77:[0,.61111,0,0,.525],78:[0,.61111,0,0,.525],79:[0,.61111,0,0,.525],80:[0,.61111,0,0,.525],81:[.13889,.61111,0,0,.525],82:[0,.61111,0,0,.525],83:[0,.61111,0,0,.525],84:[0,.61111,0,0,.525],85:[0,.61111,0,0,.525],86:[0,.61111,0,0,.525],87:[0,.61111,0,0,.525],88:[0,.61111,0,0,.525],89:[0,.61111,0,0,.525],90:[0,.61111,0,0,.525],91:[.08333,.69444,0,0,.525],92:[.08333,.69444,0,0,.525],93:[.08333,.69444,0,0,.525],94:[0,.61111,0,0,.525],95:[.09514,0,0,0,.525],96:[0,.61111,0,0,.525],97:[0,.43056,0,0,.525],98:[0,.61111,0,0,.525],99:[0,.43056,0,0,.525],100:[0,.61111,0,0,.525],101:[0,.43056,0,0,.525],102:[0,.61111,0,0,.525],103:[.22222,.43056,0,0,.525],104:[0,.61111,0,0,.525],105:[0,.61111,0,0,.525],106:[.22222,.61111,0,0,.525],107:[0,.61111,0,0,.525],108:[0,.61111,0,0,.525],109:[0,.43056,0,0,.525],110:[0,.43056,0,0,.525],111:[0,.43056,0,0,.525],112:[.22222,.43056,0,0,.525],113:[.22222,.43056,0,0,.525],114:[0,.43056,0,0,.525],115:[0,.43056,0,0,.525],116:[0,.55358,0,0,.525],117:[0,.43056,0,0,.525],118:[0,.43056,0,0,.525],119:[0,.43056,0,0,.525],120:[0,.43056,0,0,.525],121:[.22222,.43056,0,0,.525],122:[0,.43056,0,0,.525],123:[.08333,.69444,0,0,.525],124:[.08333,.69444,0,0,.525],125:[.08333,.69444,0,0,.525],126:[0,.61111,0,0,.525],127:[0,.61111,0,0,.525],160:[0,0,0,0,.525],176:[0,.61111,0,0,.525],184:[.19445,0,0,0,.525],305:[0,.43056,0,0,.525],567:[.22222,.43056,0,0,.525],711:[0,.56597,0,0,.525],713:[0,.56555,0,0,.525],714:[0,.61111,0,0,.525],715:[0,.61111,0,0,.525],728:[0,.61111,0,0,.525],730:[0,.61111,0,0,.525],770:[0,.61111,0,0,.525],771:[0,.61111,0,0,.525],776:[0,.61111,0,0,.525],915:[0,.61111,0,0,.525],916:[0,.61111,0,0,.525],920:[0,.61111,0,0,.525],923:[0,.61111,0,0,.525],926:[0,.61111,0,0,.525],928:[0,.61111,0,0,.525],931:[0,.61111,0,0,.525],933:[0,.61111,0,0,.525],934:[0,.61111,0,0,.525],936:[0,.61111,0,0,.525],937:[0,.61111,0,0,.525],8216:[0,.61111,0,0,.525],8217:[0,.61111,0,0,.525],8242:[0,.61111,0,0,.525],9251:[.11111,.21944,0,0,.525]}},ve={slant:[.25,.25,.25],space:[0,0,0],stretch:[0,0,0],shrink:[0,0,0],xHeight:[.431,.431,.431],quad:[1,1.171,1.472],extraSpace:[0,0,0],num1:[.677,.732,.925],num2:[.394,.384,.387],num3:[.444,.471,.504],denom1:[.686,.752,1.025],denom2:[.345,.344,.532],sup1:[.413,.503,.504],sup2:[.363,.431,.404],sup3:[.289,.286,.294],sub1:[.15,.143,.2],sub2:[.247,.286,.4],supDrop:[.386,.353,.494],subDrop:[.05,.071,.1],delim1:[2.39,1.7,1.98],delim2:[1.01,1.157,1.42],axisHeight:[.25,.25,.25],defaultRuleThickness:[.04,.049,.049],bigOpSpacing1:[.111,.111,.111],bigOpSpacing2:[.166,.166,.166],bigOpSpacing3:[.2,.2,.2],bigOpSpacing4:[.6,.611,.611],bigOpSpacing5:[.1,.143,.143],sqrtRuleThickness:[.04,.04,.04],ptPerEm:[10,10,10],doubleRuleSep:[.2,.2,.2],arrayRuleWidth:[.04,.04,.04],fboxsep:[.3,.3,.3],fboxrule:[.04,.04,.04]},Ht={Å:"A",Ð:"D",Þ:"o",å:"a",ð:"d",þ:"o",А:"A",Б:"B",В:"B",Г:"F",Д:"A",Е:"E",Ж:"K",З:"3",И:"N",Й:"N",К:"K",Л:"N",М:"M",Н:"H",О:"O",П:"N",Р:"P",С:"C",Т:"T",У:"y",Ф:"O",Х:"X",Ц:"U",Ч:"h",Ш:"W",Щ:"W",Ъ:"B",Ы:"X",Ь:"B",Э:"3",Ю:"X",Я:"R",а:"a",б:"b",в:"a",г:"r",д:"y",е:"e",ж:"m",з:"e",и:"n",й:"n",к:"n",л:"n",м:"m",н:"n",о:"o",п:"n",р:"p",с:"c",т:"o",у:"y",ф:"b",х:"x",ц:"n",ч:"n",ш:"w",щ:"w",ъ:"a",ы:"m",ь:"a",э:"e",ю:"m",я:"r"};function Va(r,e){w0[r]=e}function pt(r,e,t){if(!w0[e])throw new Error("Font metrics not found for font: "+e+".");var a=r.charCodeAt(0),i=w0[e][a];if(!i&&r[0]in Ht&&(a=Ht[r[0]].charCodeAt(0),i=w0[e][a]),!i&&t==="text"&&gr(a)&&(i=w0[e][77]),i)return{depth:i[0],height:i[1],italic:i[2],skew:i[3],width:i[4]}}var Ue={};function Ga(r){var e;if(r>=5?e=0:r>=3?e=1:e=2,!Ue[e]){var t=Ue[e]={cssEmPerMu:ve.quad[e]/18};for(var a in ve)ve.hasOwnProperty(a)&&(t[a]=ve[a][e])}return Ue[e]}var Ua=[[1,1,1],[2,1,1],[3,1,1],[4,2,1],[5,2,1],[6,3,1],[7,4,2],[8,6,3],[9,7,6],[10,8,7],[11,10,9]],Lt=[.5,.6,.7,.8,.9,1,1.2,1.44,1.728,2.074,2.488],Ft=function(e,t){return t.size<2?e:Ua[e-1][t.size-1]};class A0{constructor(e){this.style=void 0,this.color=void 0,this.size=void 0,this.textSize=void 0,this.phantom=void 0,this.font=void 0,this.fontFamily=void 0,this.fontWeight=void 0,this.fontShape=void 0,this.sizeMultiplier=void 0,this.maxSize=void 0,this.minRuleThickness=void 0,this._fontMetrics=void 0,this.style=e.style,this.color=e.color,this.size=e.size||A0.BASESIZE,this.textSize=e.textSize||this.size,this.phantom=!!e.phantom,this.font=e.font||"",this.fontFamily=e.fontFamily||"",this.fontWeight=e.fontWeight||"",this.fontShape=e.fontShape||"",this.sizeMultiplier=Lt[this.size-1],this.maxSize=e.maxSize,this.minRuleThickness=e.minRuleThickness,this._fontMetrics=void 0}extend(e){var t={style:this.style,size:this.size,textSize:this.textSize,color:this.color,phantom:this.phantom,font:this.font,fontFamily:this.fontFamily,fontWeight:this.fontWeight,fontShape:this.fontShape,maxSize:this.maxSize,minRuleThickness:this.minRuleThickness};for(var a in e)e.hasOwnProperty(a)&&(t[a]=e[a]);return new A0(t)}havingStyle(e){return this.style===e?this:this.extend({style:e,size:Ft(this.textSize,e)})}havingCrampedStyle(){return this.havingStyle(this.style.cramp())}havingSize(e){return this.size===e&&this.textSize===e?this:this.extend({style:this.style.text(),size:e,textSize:e,sizeMultiplier:Lt[e-1]})}havingBaseStyle(e){e=e||this.style.text();var t=Ft(A0.BASESIZE,e);return this.size===t&&this.textSize===A0.BASESIZE&&this.style===e?this:this.extend({style:e,size:t})}havingBaseSizing(){var e;switch(this.style.id){case 4:case 5:e=3;break;case 6:case 7:e=1;break;default:e=6}return this.extend({style:this.style.text(),size:e})}withColor(e){return this.extend({color:e})}withPhantom(){return this.extend({phantom:!0})}withFont(e){return this.extend({font:e})}withTextFontFamily(e){return this.extend({fontFamily:e,font:""})}withTextFontWeight(e){return this.extend({fontWeight:e,font:""})}withTextFontShape(e){return this.extend({fontShape:e,font:""})}sizingClasses(e){return e.size!==this.size?["sizing","reset-size"+e.size,"size"+this.size]:[]}baseSizingClasses(){return this.size!==A0.BASESIZE?["sizing","reset-size"+this.size,"size"+A0.BASESIZE]:[]}fontMetrics(){return this._fontMetrics||(this._fontMetrics=Ga(this.size)),this._fontMetrics}getColor(){return this.phantom?"transparent":this.color}}A0.BASESIZE=6;var nt={pt:1,mm:7227/2540,cm:7227/254,in:72.27,bp:803/800,pc:12,dd:1238/1157,cc:14856/1157,nd:685/642,nc:1370/107,sp:1/65536,px:803/800},Ya={ex:!0,em:!0,mu:!0},br=function(e){return typeof e!="string"&&(e=e.unit),e in nt||e in Ya||e==="ex"},K=function(e,t){var a;if(e.unit in nt)a=nt[e.unit]/t.fontMetrics().ptPerEm/t.sizeMultiplier;else if(e.unit==="mu")a=t.fontMetrics().cssEmPerMu;else{var i;if(t.style.isTight()?i=t.havingStyle(t.style.text()):i=t,e.unit==="ex")a=i.fontMetrics().xHeight;else if(e.unit==="em")a=i.fontMetrics().quad;else throw new M("Invalid unit: '"+e.unit+"'");i!==t&&(a*=i.sizeMultiplier/t.sizeMultiplier)}return Math.min(e.number*a,t.maxSize)},T=function(e){return+e.toFixed(4)+"em"},P0=function(e){return e.filter(t=>t).join(" ")},yr=function(e,t,a){if(this.classes=e||[],this.attributes={},this.height=0,this.depth=0,this.maxFontSize=0,this.style=a||{},t){t.style.isTight()&&this.classes.push("mtight");var i=t.getColor();i&&(this.style.color=i)}},wr=function(e){var t=document.createElement(e);t.className=P0(this.classes);for(var a in this.style)this.style.hasOwnProperty(a)&&(t.style[a]=this.style[a]);for(var i in this.attributes)this.attributes.hasOwnProperty(i)&&t.setAttribute(i,this.attributes[i]);for(var s=0;s<this.children.length;s++)t.appendChild(this.children[s].toNode());return t},Xa=/[\s"'>/=\x00-\x1f]/,xr=function(e){var t="<"+e;this.classes.length&&(t+=' class="'+V.escape(P0(this.classes))+'"');var a="";for(var i in this.style)this.style.hasOwnProperty(i)&&(a+=V.hyphenate(i)+":"+this.style[i]+";");a&&(t+=' style="'+V.escape(a)+'"');for(var s in this.attributes)if(this.attributes.hasOwnProperty(s)){if(Xa.test(s))throw new M("Invalid attribute name '"+s+"'");t+=" "+s+'="'+V.escape(this.attributes[s])+'"'}t+=">";for(var o=0;o<this.children.length;o++)t+=this.children[o].toMarkup();return t+="</"+e+">",t};class me{constructor(e,t,a,i){this.children=void 0,this.attributes=void 0,this.classes=void 0,this.height=void 0,this.depth=void 0,this.width=void 0,this.maxFontSize=void 0,this.style=void 0,yr.call(this,e,a,i),this.children=t||[]}setAttribute(e,t){this.attributes[e]=t}hasClass(e){return this.classes.includes(e)}toNode(){return wr.call(this,"span")}toMarkup(){return xr.call(this,"span")}}class vt{constructor(e,t,a,i){this.children=void 0,this.attributes=void 0,this.classes=void 0,this.height=void 0,this.depth=void 0,this.maxFontSize=void 0,this.style=void 0,yr.call(this,t,i),this.children=a||[],this.setAttribute("href",e)}setAttribute(e,t){this.attributes[e]=t}hasClass(e){return this.classes.includes(e)}toNode(){return wr.call(this,"a")}toMarkup(){return xr.call(this,"a")}}class $a{constructor(e,t,a){this.src=void 0,this.alt=void 0,this.classes=void 0,this.height=void 0,this.depth=void 0,this.maxFontSize=void 0,this.style=void 0,this.alt=t,this.src=e,this.classes=["mord"],this.style=a}hasClass(e){return this.classes.includes(e)}toNode(){var e=document.createElement("img");e.src=this.src,e.alt=this.alt,e.className="mord";for(var t in this.style)this.style.hasOwnProperty(t)&&(e.style[t]=this.style[t]);return e}toMarkup(){var e='<img src="'+V.escape(this.src)+'"'+(' alt="'+V.escape(this.alt)+'"'),t="";for(var a in this.style)this.style.hasOwnProperty(a)&&(t+=V.hyphenate(a)+":"+this.style[a]+";");return t&&(e+=' style="'+V.escape(t)+'"'),e+="'/>",e}}var Wa={î:"ı̂",ï:"ı̈",í:"ı́",ì:"ı̀"};class p0{constructor(e,t,a,i,s,o,m,c){this.text=void 0,this.height=void 0,this.depth=void 0,this.italic=void 0,this.skew=void 0,this.width=void 0,this.maxFontSize=void 0,this.classes=void 0,this.style=void 0,this.text=e,this.height=t||0,this.depth=a||0,this.italic=i||0,this.skew=s||0,this.width=o||0,this.classes=m||[],this.style=c||{},this.maxFontSize=0;var p=Ca(this.text.charCodeAt(0));p&&this.classes.push(p+"_fallback"),/[îïíì]/.test(this.text)&&(this.text=Wa[this.text])}hasClass(e){return this.classes.includes(e)}toNode(){var e=document.createTextNode(this.text),t=null;this.italic>0&&(t=document.createElement("span"),t.style.marginRight=T(this.italic)),this.classes.length>0&&(t=t||document.createElement("span"),t.className=P0(this.classes));for(var a in this.style)this.style.hasOwnProperty(a)&&(t=t||document.createElement("span"),t.style[a]=this.style[a]);return t?(t.appendChild(e),t):e}toMarkup(){var e=!1,t="<span";this.classes.length&&(e=!0,t+=' class="',t+=V.escape(P0(this.classes)),t+='"');var a="";this.italic>0&&(a+="margin-right:"+this.italic+"em;");for(var i in this.style)this.style.hasOwnProperty(i)&&(a+=V.hyphenate(i)+":"+this.style[i]+";");a&&(e=!0,t+=' style="'+V.escape(a)+'"');var s=V.escape(this.text);return e?(t+=">",t+=s,t+="</span>",t):s}}class C0{constructor(e,t){this.children=void 0,this.attributes=void 0,this.children=e||[],this.attributes=t||{}}toNode(){var e="http://www.w3.org/2000/svg",t=document.createElementNS(e,"svg");for(var a in this.attributes)Object.prototype.hasOwnProperty.call(this.attributes,a)&&t.setAttribute(a,this.attributes[a]);for(var i=0;i<this.children.length;i++)t.appendChild(this.children[i].toNode());return t}toMarkup(){var e='<svg xmlns="http://www.w3.org/2000/svg"';for(var t in this.attributes)Object.prototype.hasOwnProperty.call(this.attributes,t)&&(e+=" "+t+'="'+V.escape(this.attributes[t])+'"');e+=">";for(var a=0;a<this.children.length;a++)e+=this.children[a].toMarkup();return e+="</svg>",e}}class V0{constructor(e,t){this.pathName=void 0,this.alternate=void 0,this.pathName=e,this.alternate=t}toNode(){var e="http://www.w3.org/2000/svg",t=document.createElementNS(e,"path");return this.alternate?t.setAttribute("d",this.alternate):t.setAttribute("d",Ot[this.pathName]),t}toMarkup(){return this.alternate?'<path d="'+V.escape(this.alternate)+'"/>':'<path d="'+V.escape(Ot[this.pathName])+'"/>'}}class st{constructor(e){this.attributes=void 0,this.attributes=e||{}}toNode(){var e="http://www.w3.org/2000/svg",t=document.createElementNS(e,"line");for(var a in this.attributes)Object.prototype.hasOwnProperty.call(this.attributes,a)&&t.setAttribute(a,this.attributes[a]);return t}toMarkup(){var e="<line";for(var t in this.attributes)Object.prototype.hasOwnProperty.call(this.attributes,t)&&(e+=" "+t+'="'+V.escape(this.attributes[t])+'"');return e+="/>",e}}function Pt(r){if(r instanceof p0)return r;throw new Error("Expected symbolNode but got "+String(r)+".")}function ja(r){if(r instanceof me)return r;throw new Error("Expected span<HtmlDomNode> but got "+String(r)+".")}var Za={bin:1,close:1,inner:1,open:1,punct:1,rel:1},Ka={"accent-token":1,mathord:1,"op-token":1,spacing:1,textord:1},$={math:{},text:{}};function n(r,e,t,a,i,s){$[r][i]={font:e,group:t,replace:a},s&&a&&($[r][a]=$[r][i])}var l="math",k="text",h="main",d="ams",W="accent-token",N="bin",n0="close",re="inner",R="mathord",_="op-token",c0="open",Re="punct",f="rel",I0="spacing",v="textord";n(l,h,f,"≡","\\equiv",!0);n(l,h,f,"≺","\\prec",!0);n(l,h,f,"≻","\\succ",!0);n(l,h,f,"∼","\\sim",!0);n(l,h,f,"⊥","\\perp");n(l,h,f,"⪯","\\preceq",!0);n(l,h,f,"⪰","\\succeq",!0);n(l,h,f,"≃","\\simeq",!0);n(l,h,f,"∣","\\mid",!0);n(l,h,f,"≪","\\ll",!0);n(l,h,f,"≫","\\gg",!0);n(l,h,f,"≍","\\asymp",!0);n(l,h,f,"∥","\\parallel");n(l,h,f,"⋈","\\bowtie",!0);n(l,h,f,"⌣","\\smile",!0);n(l,h,f,"⊑","\\sqsubseteq",!0);n(l,h,f,"⊒","\\sqsupseteq",!0);n(l,h,f,"≐","\\doteq",!0);n(l,h,f,"⌢","\\frown",!0);n(l,h,f,"∋","\\ni",!0);n(l,h,f,"∝","\\propto",!0);n(l,h,f,"⊢","\\vdash",!0);n(l,h,f,"⊣","\\dashv",!0);n(l,h,f,"∋","\\owns");n(l,h,Re,".","\\ldotp");n(l,h,Re,"⋅","\\cdotp");n(l,h,v,"#","\\#");n(k,h,v,"#","\\#");n(l,h,v,"&","\\&");n(k,h,v,"&","\\&");n(l,h,v,"ℵ","\\aleph",!0);n(l,h,v,"∀","\\forall",!0);n(l,h,v,"ℏ","\\hbar",!0);n(l,h,v,"∃","\\exists",!0);n(l,h,v,"∇","\\nabla",!0);n(l,h,v,"♭","\\flat",!0);n(l,h,v,"ℓ","\\ell",!0);n(l,h,v,"♮","\\natural",!0);n(l,h,v,"♣","\\clubsuit",!0);n(l,h,v,"℘","\\wp",!0);n(l,h,v,"♯","\\sharp",!0);n(l,h,v,"♢","\\diamondsuit",!0);n(l,h,v,"ℜ","\\Re",!0);n(l,h,v,"♡","\\heartsuit",!0);n(l,h,v,"ℑ","\\Im",!0);n(l,h,v,"♠","\\spadesuit",!0);n(l,h,v,"§","\\S",!0);n(k,h,v,"§","\\S");n(l,h,v,"¶","\\P",!0);n(k,h,v,"¶","\\P");n(l,h,v,"†","\\dag");n(k,h,v,"†","\\dag");n(k,h,v,"†","\\textdagger");n(l,h,v,"‡","\\ddag");n(k,h,v,"‡","\\ddag");n(k,h,v,"‡","\\textdaggerdbl");n(l,h,n0,"⎱","\\rmoustache",!0);n(l,h,c0,"⎰","\\lmoustache",!0);n(l,h,n0,"⟯","\\rgroup",!0);n(l,h,c0,"⟮","\\lgroup",!0);n(l,h,N,"∓","\\mp",!0);n(l,h,N,"⊖","\\ominus",!0);n(l,h,N,"⊎","\\uplus",!0);n(l,h,N,"⊓","\\sqcap",!0);n(l,h,N,"∗","\\ast");n(l,h,N,"⊔","\\sqcup",!0);n(l,h,N,"◯","\\bigcirc",!0);n(l,h,N,"∙","\\bullet",!0);n(l,h,N,"‡","\\ddagger");n(l,h,N,"≀","\\wr",!0);n(l,h,N,"⨿","\\amalg");n(l,h,N,"&","\\And");n(l,h,f,"⟵","\\longleftarrow",!0);n(l,h,f,"⇐","\\Leftarrow",!0);n(l,h,f,"⟸","\\Longleftarrow",!0);n(l,h,f,"⟶","\\longrightarrow",!0);n(l,h,f,"⇒","\\Rightarrow",!0);n(l,h,f,"⟹","\\Longrightarrow",!0);n(l,h,f,"↔","\\leftrightarrow",!0);n(l,h,f,"⟷","\\longleftrightarrow",!0);n(l,h,f,"⇔","\\Leftrightarrow",!0);n(l,h,f,"⟺","\\Longleftrightarrow",!0);n(l,h,f,"↦","\\mapsto",!0);n(l,h,f,"⟼","\\longmapsto",!0);n(l,h,f,"↗","\\nearrow",!0);n(l,h,f,"↩","\\hookleftarrow",!0);n(l,h,f,"↪","\\hookrightarrow",!0);n(l,h,f,"↘","\\searrow",!0);n(l,h,f,"↼","\\leftharpoonup",!0);n(l,h,f,"⇀","\\rightharpoonup",!0);n(l,h,f,"↙","\\swarrow",!0);n(l,h,f,"↽","\\leftharpoondown",!0);n(l,h,f,"⇁","\\rightharpoondown",!0);n(l,h,f,"↖","\\nwarrow",!0);n(l,h,f,"⇌","\\rightleftharpoons",!0);n(l,d,f,"≮","\\nless",!0);n(l,d,f,"","\\@nleqslant");n(l,d,f,"","\\@nleqq");n(l,d,f,"⪇","\\lneq",!0);n(l,d,f,"≨","\\lneqq",!0);n(l,d,f,"","\\@lvertneqq");n(l,d,f,"⋦","\\lnsim",!0);n(l,d,f,"⪉","\\lnapprox",!0);n(l,d,f,"⊀","\\nprec",!0);n(l,d,f,"⋠","\\npreceq",!0);n(l,d,f,"⋨","\\precnsim",!0);n(l,d,f,"⪹","\\precnapprox",!0);n(l,d,f,"≁","\\nsim",!0);n(l,d,f,"","\\@nshortmid");n(l,d,f,"∤","\\nmid",!0);n(l,d,f,"⊬","\\nvdash",!0);n(l,d,f,"⊭","\\nvDash",!0);n(l,d,f,"⋪","\\ntriangleleft");n(l,d,f,"⋬","\\ntrianglelefteq",!0);n(l,d,f,"⊊","\\subsetneq",!0);n(l,d,f,"","\\@varsubsetneq");n(l,d,f,"⫋","\\subsetneqq",!0);n(l,d,f,"","\\@varsubsetneqq");n(l,d,f,"≯","\\ngtr",!0);n(l,d,f,"","\\@ngeqslant");n(l,d,f,"","\\@ngeqq");n(l,d,f,"⪈","\\gneq",!0);n(l,d,f,"≩","\\gneqq",!0);n(l,d,f,"","\\@gvertneqq");n(l,d,f,"⋧","\\gnsim",!0);n(l,d,f,"⪊","\\gnapprox",!0);n(l,d,f,"⊁","\\nsucc",!0);n(l,d,f,"⋡","\\nsucceq",!0);n(l,d,f,"⋩","\\succnsim",!0);n(l,d,f,"⪺","\\succnapprox",!0);n(l,d,f,"≆","\\ncong",!0);n(l,d,f,"","\\@nshortparallel");n(l,d,f,"∦","\\nparallel",!0);n(l,d,f,"⊯","\\nVDash",!0);n(l,d,f,"⋫","\\ntriangleright");n(l,d,f,"⋭","\\ntrianglerighteq",!0);n(l,d,f,"","\\@nsupseteqq");n(l,d,f,"⊋","\\supsetneq",!0);n(l,d,f,"","\\@varsupsetneq");n(l,d,f,"⫌","\\supsetneqq",!0);n(l,d,f,"","\\@varsupsetneqq");n(l,d,f,"⊮","\\nVdash",!0);n(l,d,f,"⪵","\\precneqq",!0);n(l,d,f,"⪶","\\succneqq",!0);n(l,d,f,"","\\@nsubseteqq");n(l,d,N,"⊴","\\unlhd");n(l,d,N,"⊵","\\unrhd");n(l,d,f,"↚","\\nleftarrow",!0);n(l,d,f,"↛","\\nrightarrow",!0);n(l,d,f,"⇍","\\nLeftarrow",!0);n(l,d,f,"⇏","\\nRightarrow",!0);n(l,d,f,"↮","\\nleftrightarrow",!0);n(l,d,f,"⇎","\\nLeftrightarrow",!0);n(l,d,f,"△","\\vartriangle");n(l,d,v,"ℏ","\\hslash");n(l,d,v,"▽","\\triangledown");n(l,d,v,"◊","\\lozenge");n(l,d,v,"Ⓢ","\\circledS");n(l,d,v,"®","\\circledR");n(k,d,v,"®","\\circledR");n(l,d,v,"∡","\\measuredangle",!0);n(l,d,v,"∄","\\nexists");n(l,d,v,"℧","\\mho");n(l,d,v,"Ⅎ","\\Finv",!0);n(l,d,v,"⅁","\\Game",!0);n(l,d,v,"‵","\\backprime");n(l,d,v,"▲","\\blacktriangle");n(l,d,v,"▼","\\blacktriangledown");n(l,d,v,"■","\\blacksquare");n(l,d,v,"⧫","\\blacklozenge");n(l,d,v,"★","\\bigstar");n(l,d,v,"∢","\\sphericalangle",!0);n(l,d,v,"∁","\\complement",!0);n(l,d,v,"ð","\\eth",!0);n(k,h,v,"ð","ð");n(l,d,v,"╱","\\diagup");n(l,d,v,"╲","\\diagdown");n(l,d,v,"□","\\square");n(l,d,v,"□","\\Box");n(l,d,v,"◊","\\Diamond");n(l,d,v,"¥","\\yen",!0);n(k,d,v,"¥","\\yen",!0);n(l,d,v,"✓","\\checkmark",!0);n(k,d,v,"✓","\\checkmark");n(l,d,v,"ℶ","\\beth",!0);n(l,d,v,"ℸ","\\daleth",!0);n(l,d,v,"ℷ","\\gimel",!0);n(l,d,v,"ϝ","\\digamma",!0);n(l,d,v,"ϰ","\\varkappa");n(l,d,c0,"┌","\\@ulcorner",!0);n(l,d,n0,"┐","\\@urcorner",!0);n(l,d,c0,"└","\\@llcorner",!0);n(l,d,n0,"┘","\\@lrcorner",!0);n(l,d,f,"≦","\\leqq",!0);n(l,d,f,"⩽","\\leqslant",!0);n(l,d,f,"⪕","\\eqslantless",!0);n(l,d,f,"≲","\\lesssim",!0);n(l,d,f,"⪅","\\lessapprox",!0);n(l,d,f,"≊","\\approxeq",!0);n(l,d,N,"⋖","\\lessdot");n(l,d,f,"⋘","\\lll",!0);n(l,d,f,"≶","\\lessgtr",!0);n(l,d,f,"⋚","\\lesseqgtr",!0);n(l,d,f,"⪋","\\lesseqqgtr",!0);n(l,d,f,"≑","\\doteqdot");n(l,d,f,"≓","\\risingdotseq",!0);n(l,d,f,"≒","\\fallingdotseq",!0);n(l,d,f,"∽","\\backsim",!0);n(l,d,f,"⋍","\\backsimeq",!0);n(l,d,f,"⫅","\\subseteqq",!0);n(l,d,f,"⋐","\\Subset",!0);n(l,d,f,"⊏","\\sqsubset",!0);n(l,d,f,"≼","\\preccurlyeq",!0);n(l,d,f,"⋞","\\curlyeqprec",!0);n(l,d,f,"≾","\\precsim",!0);n(l,d,f,"⪷","\\precapprox",!0);n(l,d,f,"⊲","\\vartriangleleft");n(l,d,f,"⊴","\\trianglelefteq");n(l,d,f,"⊨","\\vDash",!0);n(l,d,f,"⊪","\\Vvdash",!0);n(l,d,f,"⌣","\\smallsmile");n(l,d,f,"⌢","\\smallfrown");n(l,d,f,"≏","\\bumpeq",!0);n(l,d,f,"≎","\\Bumpeq",!0);n(l,d,f,"≧","\\geqq",!0);n(l,d,f,"⩾","\\geqslant",!0);n(l,d,f,"⪖","\\eqslantgtr",!0);n(l,d,f,"≳","\\gtrsim",!0);n(l,d,f,"⪆","\\gtrapprox",!0);n(l,d,N,"⋗","\\gtrdot");n(l,d,f,"⋙","\\ggg",!0);n(l,d,f,"≷","\\gtrless",!0);n(l,d,f,"⋛","\\gtreqless",!0);n(l,d,f,"⪌","\\gtreqqless",!0);n(l,d,f,"≖","\\eqcirc",!0);n(l,d,f,"≗","\\circeq",!0);n(l,d,f,"≜","\\triangleq",!0);n(l,d,f,"∼","\\thicksim");n(l,d,f,"≈","\\thickapprox");n(l,d,f,"⫆","\\supseteqq",!0);n(l,d,f,"⋑","\\Supset",!0);n(l,d,f,"⊐","\\sqsupset",!0);n(l,d,f,"≽","\\succcurlyeq",!0);n(l,d,f,"⋟","\\curlyeqsucc",!0);n(l,d,f,"≿","\\succsim",!0);n(l,d,f,"⪸","\\succapprox",!0);n(l,d,f,"⊳","\\vartriangleright");n(l,d,f,"⊵","\\trianglerighteq");n(l,d,f,"⊩","\\Vdash",!0);n(l,d,f,"∣","\\shortmid");n(l,d,f,"∥","\\shortparallel");n(l,d,f,"≬","\\between",!0);n(l,d,f,"⋔","\\pitchfork",!0);n(l,d,f,"∝","\\varpropto");n(l,d,f,"◀","\\blacktriangleleft");n(l,d,f,"∴","\\therefore",!0);n(l,d,f,"∍","\\backepsilon");n(l,d,f,"▶","\\blacktriangleright");n(l,d,f,"∵","\\because",!0);n(l,d,f,"⋘","\\llless");n(l,d,f,"⋙","\\gggtr");n(l,d,N,"⊲","\\lhd");n(l,d,N,"⊳","\\rhd");n(l,d,f,"≂","\\eqsim",!0);n(l,h,f,"⋈","\\Join");n(l,d,f,"≑","\\Doteq",!0);n(l,d,N,"∔","\\dotplus",!0);n(l,d,N,"∖","\\smallsetminus");n(l,d,N,"⋒","\\Cap",!0);n(l,d,N,"⋓","\\Cup",!0);n(l,d,N,"⩞","\\doublebarwedge",!0);n(l,d,N,"⊟","\\boxminus",!0);n(l,d,N,"⊞","\\boxplus",!0);n(l,d,N,"⋇","\\divideontimes",!0);n(l,d,N,"⋉","\\ltimes",!0);n(l,d,N,"⋊","\\rtimes",!0);n(l,d,N,"⋋","\\leftthreetimes",!0);n(l,d,N,"⋌","\\rightthreetimes",!0);n(l,d,N,"⋏","\\curlywedge",!0);n(l,d,N,"⋎","\\curlyvee",!0);n(l,d,N,"⊝","\\circleddash",!0);n(l,d,N,"⊛","\\circledast",!0);n(l,d,N,"⋅","\\centerdot");n(l,d,N,"⊺","\\intercal",!0);n(l,d,N,"⋒","\\doublecap");n(l,d,N,"⋓","\\doublecup");n(l,d,N,"⊠","\\boxtimes",!0);n(l,d,f,"⇢","\\dashrightarrow",!0);n(l,d,f,"⇠","\\dashleftarrow",!0);n(l,d,f,"⇇","\\leftleftarrows",!0);n(l,d,f,"⇆","\\leftrightarrows",!0);n(l,d,f,"⇚","\\Lleftarrow",!0);n(l,d,f,"↞","\\twoheadleftarrow",!0);n(l,d,f,"↢","\\leftarrowtail",!0);n(l,d,f,"↫","\\looparrowleft",!0);n(l,d,f,"⇋","\\leftrightharpoons",!0);n(l,d,f,"↶","\\curvearrowleft",!0);n(l,d,f,"↺","\\circlearrowleft",!0);n(l,d,f,"↰","\\Lsh",!0);n(l,d,f,"⇈","\\upuparrows",!0);n(l,d,f,"↿","\\upharpoonleft",!0);n(l,d,f,"⇃","\\downharpoonleft",!0);n(l,h,f,"⊶","\\origof",!0);n(l,h,f,"⊷","\\imageof",!0);n(l,d,f,"⊸","\\multimap",!0);n(l,d,f,"↭","\\leftrightsquigarrow",!0);n(l,d,f,"⇉","\\rightrightarrows",!0);n(l,d,f,"⇄","\\rightleftarrows",!0);n(l,d,f,"↠","\\twoheadrightarrow",!0);n(l,d,f,"↣","\\rightarrowtail",!0);n(l,d,f,"↬","\\looparrowright",!0);n(l,d,f,"↷","\\curvearrowright",!0);n(l,d,f,"↻","\\circlearrowright",!0);n(l,d,f,"↱","\\Rsh",!0);n(l,d,f,"⇊","\\downdownarrows",!0);n(l,d,f,"↾","\\upharpoonright",!0);n(l,d,f,"⇂","\\downharpoonright",!0);n(l,d,f,"⇝","\\rightsquigarrow",!0);n(l,d,f,"⇝","\\leadsto");n(l,d,f,"⇛","\\Rrightarrow",!0);n(l,d,f,"↾","\\restriction");n(l,h,v,"‘","`");n(l,h,v,"$","\\$");n(k,h,v,"$","\\$");n(k,h,v,"$","\\textdollar");n(l,h,v,"%","\\%");n(k,h,v,"%","\\%");n(l,h,v,"_","\\_");n(k,h,v,"_","\\_");n(k,h,v,"_","\\textunderscore");n(l,h,v,"∠","\\angle",!0);n(l,h,v,"∞","\\infty",!0);n(l,h,v,"′","\\prime");n(l,h,v,"△","\\triangle");n(l,h,v,"Γ","\\Gamma",!0);n(l,h,v,"Δ","\\Delta",!0);n(l,h,v,"Θ","\\Theta",!0);n(l,h,v,"Λ","\\Lambda",!0);n(l,h,v,"Ξ","\\Xi",!0);n(l,h,v,"Π","\\Pi",!0);n(l,h,v,"Σ","\\Sigma",!0);n(l,h,v,"Υ","\\Upsilon",!0);n(l,h,v,"Φ","\\Phi",!0);n(l,h,v,"Ψ","\\Psi",!0);n(l,h,v,"Ω","\\Omega",!0);n(l,h,v,"A","Α");n(l,h,v,"B","Β");n(l,h,v,"E","Ε");n(l,h,v,"Z","Ζ");n(l,h,v,"H","Η");n(l,h,v,"I","Ι");n(l,h,v,"K","Κ");n(l,h,v,"M","Μ");n(l,h,v,"N","Ν");n(l,h,v,"O","Ο");n(l,h,v,"P","Ρ");n(l,h,v,"T","Τ");n(l,h,v,"X","Χ");n(l,h,v,"¬","\\neg",!0);n(l,h,v,"¬","\\lnot");n(l,h,v,"⊤","\\top");n(l,h,v,"⊥","\\bot");n(l,h,v,"∅","\\emptyset");n(l,d,v,"∅","\\varnothing");n(l,h,R,"α","\\alpha",!0);n(l,h,R,"β","\\beta",!0);n(l,h,R,"γ","\\gamma",!0);n(l,h,R,"δ","\\delta",!0);n(l,h,R,"ϵ","\\epsilon",!0);n(l,h,R,"ζ","\\zeta",!0);n(l,h,R,"η","\\eta",!0);n(l,h,R,"θ","\\theta",!0);n(l,h,R,"ι","\\iota",!0);n(l,h,R,"κ","\\kappa",!0);n(l,h,R,"λ","\\lambda",!0);n(l,h,R,"μ","\\mu",!0);n(l,h,R,"ν","\\nu",!0);n(l,h,R,"ξ","\\xi",!0);n(l,h,R,"ο","\\omicron",!0);n(l,h,R,"π","\\pi",!0);n(l,h,R,"ρ","\\rho",!0);n(l,h,R,"σ","\\sigma",!0);n(l,h,R,"τ","\\tau",!0);n(l,h,R,"υ","\\upsilon",!0);n(l,h,R,"ϕ","\\phi",!0);n(l,h,R,"χ","\\chi",!0);n(l,h,R,"ψ","\\psi",!0);n(l,h,R,"ω","\\omega",!0);n(l,h,R,"ε","\\varepsilon",!0);n(l,h,R,"ϑ","\\vartheta",!0);n(l,h,R,"ϖ","\\varpi",!0);n(l,h,R,"ϱ","\\varrho",!0);n(l,h,R,"ς","\\varsigma",!0);n(l,h,R,"φ","\\varphi",!0);n(l,h,N,"∗","*",!0);n(l,h,N,"+","+");n(l,h,N,"−","-",!0);n(l,h,N,"⋅","\\cdot",!0);n(l,h,N,"∘","\\circ",!0);n(l,h,N,"÷","\\div",!0);n(l,h,N,"±","\\pm",!0);n(l,h,N,"×","\\times",!0);n(l,h,N,"∩","\\cap",!0);n(l,h,N,"∪","\\cup",!0);n(l,h,N,"∖","\\setminus",!0);n(l,h,N,"∧","\\land");n(l,h,N,"∨","\\lor");n(l,h,N,"∧","\\wedge",!0);n(l,h,N,"∨","\\vee",!0);n(l,h,v,"√","\\surd");n(l,h,c0,"⟨","\\langle",!0);n(l,h,c0,"∣","\\lvert");n(l,h,c0,"∥","\\lVert");n(l,h,n0,"?","?");n(l,h,n0,"!","!");n(l,h,n0,"⟩","\\rangle",!0);n(l,h,n0,"∣","\\rvert");n(l,h,n0,"∥","\\rVert");n(l,h,f,"=","=");n(l,h,f,":",":");n(l,h,f,"≈","\\approx",!0);n(l,h,f,"≅","\\cong",!0);n(l,h,f,"≥","\\ge");n(l,h,f,"≥","\\geq",!0);n(l,h,f,"←","\\gets");n(l,h,f,">","\\gt",!0);n(l,h,f,"∈","\\in",!0);n(l,h,f,"","\\@not");n(l,h,f,"⊂","\\subset",!0);n(l,h,f,"⊃","\\supset",!0);n(l,h,f,"⊆","\\subseteq",!0);n(l,h,f,"⊇","\\supseteq",!0);n(l,d,f,"⊈","\\nsubseteq",!0);n(l,d,f,"⊉","\\nsupseteq",!0);n(l,h,f,"⊨","\\models");n(l,h,f,"←","\\leftarrow",!0);n(l,h,f,"≤","\\le");n(l,h,f,"≤","\\leq",!0);n(l,h,f,"<","\\lt",!0);n(l,h,f,"→","\\rightarrow",!0);n(l,h,f,"→","\\to");n(l,d,f,"≱","\\ngeq",!0);n(l,d,f,"≰","\\nleq",!0);n(l,h,I0," ","\\ ");n(l,h,I0," ","\\space");n(l,h,I0," ","\\nobreakspace");n(k,h,I0," ","\\ ");n(k,h,I0," "," ");n(k,h,I0," ","\\space");n(k,h,I0," ","\\nobreakspace");n(l,h,I0,null,"\\nobreak");n(l,h,I0,null,"\\allowbreak");n(l,h,Re,",",",");n(l,h,Re,";",";");n(l,d,N,"⊼","\\barwedge",!0);n(l,d,N,"⊻","\\veebar",!0);n(l,h,N,"⊙","\\odot",!0);n(l,h,N,"⊕","\\oplus",!0);n(l,h,N,"⊗","\\otimes",!0);n(l,h,v,"∂","\\partial",!0);n(l,h,N,"⊘","\\oslash",!0);n(l,d,N,"⊚","\\circledcirc",!0);n(l,d,N,"⊡","\\boxdot",!0);n(l,h,N,"△","\\bigtriangleup");n(l,h,N,"▽","\\bigtriangledown");n(l,h,N,"†","\\dagger");n(l,h,N,"⋄","\\diamond");n(l,h,N,"⋆","\\star");n(l,h,N,"◃","\\triangleleft");n(l,h,N,"▹","\\triangleright");n(l,h,c0,"{","\\{");n(k,h,v,"{","\\{");n(k,h,v,"{","\\textbraceleft");n(l,h,n0,"}","\\}");n(k,h,v,"}","\\}");n(k,h,v,"}","\\textbraceright");n(l,h,c0,"{","\\lbrace");n(l,h,n0,"}","\\rbrace");n(l,h,c0,"[","\\lbrack",!0);n(k,h,v,"[","\\lbrack",!0);n(l,h,n0,"]","\\rbrack",!0);n(k,h,v,"]","\\rbrack",!0);n(l,h,c0,"(","\\lparen",!0);n(l,h,n0,")","\\rparen",!0);n(k,h,v,"<","\\textless",!0);n(k,h,v,">","\\textgreater",!0);n(l,h,c0,"⌊","\\lfloor",!0);n(l,h,n0,"⌋","\\rfloor",!0);n(l,h,c0,"⌈","\\lceil",!0);n(l,h,n0,"⌉","\\rceil",!0);n(l,h,v,"\\","\\backslash");n(l,h,v,"∣","|");n(l,h,v,"∣","\\vert");n(k,h,v,"|","\\textbar",!0);n(l,h,v,"∥","\\|");n(l,h,v,"∥","\\Vert");n(k,h,v,"∥","\\textbardbl");n(k,h,v,"~","\\textasciitilde");n(k,h,v,"\\","\\textbackslash");n(k,h,v,"^","\\textasciicircum");n(l,h,f,"↑","\\uparrow",!0);n(l,h,f,"⇑","\\Uparrow",!0);n(l,h,f,"↓","\\downarrow",!0);n(l,h,f,"⇓","\\Downarrow",!0);n(l,h,f,"↕","\\updownarrow",!0);n(l,h,f,"⇕","\\Updownarrow",!0);n(l,h,_,"∐","\\coprod");n(l,h,_,"⋁","\\bigvee");n(l,h,_,"⋀","\\bigwedge");n(l,h,_,"⨄","\\biguplus");n(l,h,_,"⋂","\\bigcap");n(l,h,_,"⋃","\\bigcup");n(l,h,_,"∫","\\int");n(l,h,_,"∫","\\intop");n(l,h,_,"∬","\\iint");n(l,h,_,"∭","\\iiint");n(l,h,_,"∏","\\prod");n(l,h,_,"∑","\\sum");n(l,h,_,"⨂","\\bigotimes");n(l,h,_,"⨁","\\bigoplus");n(l,h,_,"⨀","\\bigodot");n(l,h,_,"∮","\\oint");n(l,h,_,"∯","\\oiint");n(l,h,_,"∰","\\oiiint");n(l,h,_,"⨆","\\bigsqcup");n(l,h,_,"∫","\\smallint");n(k,h,re,"…","\\textellipsis");n(l,h,re,"…","\\mathellipsis");n(k,h,re,"…","\\ldots",!0);n(l,h,re,"…","\\ldots",!0);n(l,h,re,"⋯","\\@cdots",!0);n(l,h,re,"⋱","\\ddots",!0);n(l,h,v,"⋮","\\varvdots");n(k,h,v,"⋮","\\varvdots");n(l,h,W,"ˊ","\\acute");n(l,h,W,"ˋ","\\grave");n(l,h,W,"¨","\\ddot");n(l,h,W,"~","\\tilde");n(l,h,W,"ˉ","\\bar");n(l,h,W,"˘","\\breve");n(l,h,W,"ˇ","\\check");n(l,h,W,"^","\\hat");n(l,h,W,"⃗","\\vec");n(l,h,W,"˙","\\dot");n(l,h,W,"˚","\\mathring");n(l,h,R,"","\\@imath");n(l,h,R,"","\\@jmath");n(l,h,v,"ı","ı");n(l,h,v,"ȷ","ȷ");n(k,h,v,"ı","\\i",!0);n(k,h,v,"ȷ","\\j",!0);n(k,h,v,"ß","\\ss",!0);n(k,h,v,"æ","\\ae",!0);n(k,h,v,"œ","\\oe",!0);n(k,h,v,"ø","\\o",!0);n(k,h,v,"Æ","\\AE",!0);n(k,h,v,"Œ","\\OE",!0);n(k,h,v,"Ø","\\O",!0);n(k,h,W,"ˊ","\\'");n(k,h,W,"ˋ","\\`");n(k,h,W,"ˆ","\\^");n(k,h,W,"˜","\\~");n(k,h,W,"ˉ","\\=");n(k,h,W,"˘","\\u");n(k,h,W,"˙","\\.");n(k,h,W,"¸","\\c");n(k,h,W,"˚","\\r");n(k,h,W,"ˇ","\\v");n(k,h,W,"¨",'\\"');n(k,h,W,"˝","\\H");n(k,h,W,"◯","\\textcircled");var kr={"--":!0,"---":!0,"``":!0,"''":!0};n(k,h,v,"–","--",!0);n(k,h,v,"–","\\textendash");n(k,h,v,"—","---",!0);n(k,h,v,"—","\\textemdash");n(k,h,v,"‘","`",!0);n(k,h,v,"‘","\\textquoteleft");n(k,h,v,"’","'",!0);n(k,h,v,"’","\\textquoteright");n(k,h,v,"“","``",!0);n(k,h,v,"“","\\textquotedblleft");n(k,h,v,"”","''",!0);n(k,h,v,"”","\\textquotedblright");n(l,h,v,"°","\\degree",!0);n(k,h,v,"°","\\degree");n(k,h,v,"°","\\textdegree",!0);n(l,h,v,"£","\\pounds");n(l,h,v,"£","\\mathsterling",!0);n(k,h,v,"£","\\pounds");n(k,h,v,"£","\\textsterling",!0);n(l,d,v,"✠","\\maltese");n(k,d,v,"✠","\\maltese");var Vt='0123456789/@."';for(var Ye=0;Ye<Vt.length;Ye++){var Gt=Vt.charAt(Ye);n(l,h,v,Gt,Gt)}var Ut='0123456789!@*()-=+";:?/.,';for(var Xe=0;Xe<Ut.length;Xe++){var Yt=Ut.charAt(Xe);n(k,h,v,Yt,Yt)}var Be="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";for(var $e=0;$e<Be.length;$e++){var ge=Be.charAt($e);n(l,h,R,ge,ge),n(k,h,v,ge,ge)}n(l,d,v,"C","ℂ");n(k,d,v,"C","ℂ");n(l,d,v,"H","ℍ");n(k,d,v,"H","ℍ");n(l,d,v,"N","ℕ");n(k,d,v,"N","ℕ");n(l,d,v,"P","ℙ");n(k,d,v,"P","ℙ");n(l,d,v,"Q","ℚ");n(k,d,v,"Q","ℚ");n(l,d,v,"R","ℝ");n(k,d,v,"R","ℝ");n(l,d,v,"Z","ℤ");n(k,d,v,"Z","ℤ");n(l,h,R,"h","ℎ");n(k,h,R,"h","ℎ");var D="";for(var a0=0;a0<Be.length;a0++){var J=Be.charAt(a0);D=String.fromCharCode(55349,56320+a0),n(l,h,R,J,D),n(k,h,v,J,D),D=String.fromCharCode(55349,56372+a0),n(l,h,R,J,D),n(k,h,v,J,D),D=String.fromCharCode(55349,56424+a0),n(l,h,R,J,D),n(k,h,v,J,D),D=String.fromCharCode(55349,56580+a0),n(l,h,R,J,D),n(k,h,v,J,D),D=String.fromCharCode(55349,56684+a0),n(l,h,R,J,D),n(k,h,v,J,D),D=String.fromCharCode(55349,56736+a0),n(l,h,R,J,D),n(k,h,v,J,D),D=String.fromCharCode(55349,56788+a0),n(l,h,R,J,D),n(k,h,v,J,D),D=String.fromCharCode(55349,56840+a0),n(l,h,R,J,D),n(k,h,v,J,D),D=String.fromCharCode(55349,56944+a0),n(l,h,R,J,D),n(k,h,v,J,D),a0<26&&(D=String.fromCharCode(55349,56632+a0),n(l,h,R,J,D),n(k,h,v,J,D),D=String.fromCharCode(55349,56476+a0),n(l,h,R,J,D),n(k,h,v,J,D))}D="𝕜";n(l,h,R,"k",D);n(k,h,v,"k",D);for(var X0=0;X0<10;X0++){var L0=X0.toString();D=String.fromCharCode(55349,57294+X0),n(l,h,R,L0,D),n(k,h,v,L0,D),D=String.fromCharCode(55349,57314+X0),n(l,h,R,L0,D),n(k,h,v,L0,D),D=String.fromCharCode(55349,57324+X0),n(l,h,R,L0,D),n(k,h,v,L0,D),D=String.fromCharCode(55349,57334+X0),n(l,h,R,L0,D),n(k,h,v,L0,D)}var lt="ÐÞþ";for(var We=0;We<lt.length;We++){var be=lt.charAt(We);n(l,h,R,be,be),n(k,h,v,be,be)}var ye=[["mathbf","textbf","Main-Bold"],["mathbf","textbf","Main-Bold"],["mathnormal","textit","Math-Italic"],["mathnormal","textit","Math-Italic"],["boldsymbol","boldsymbol","Main-BoldItalic"],["boldsymbol","boldsymbol","Main-BoldItalic"],["mathscr","textscr","Script-Regular"],["","",""],["","",""],["","",""],["mathfrak","textfrak","Fraktur-Regular"],["mathfrak","textfrak","Fraktur-Regular"],["mathbb","textbb","AMS-Regular"],["mathbb","textbb","AMS-Regular"],["mathboldfrak","textboldfrak","Fraktur-Regular"],["mathboldfrak","textboldfrak","Fraktur-Regular"],["mathsf","textsf","SansSerif-Regular"],["mathsf","textsf","SansSerif-Regular"],["mathboldsf","textboldsf","SansSerif-Bold"],["mathboldsf","textboldsf","SansSerif-Bold"],["mathitsf","textitsf","SansSerif-Italic"],["mathitsf","textitsf","SansSerif-Italic"],["","",""],["","",""],["mathtt","texttt","Typewriter-Regular"],["mathtt","texttt","Typewriter-Regular"]],Xt=[["mathbf","textbf","Main-Bold"],["","",""],["mathsf","textsf","SansSerif-Regular"],["mathboldsf","textboldsf","SansSerif-Bold"],["mathtt","texttt","Typewriter-Regular"]],Ja=function(e,t){var a=e.charCodeAt(0),i=e.charCodeAt(1),s=(a-55296)*1024+(i-56320)+65536,o=t==="math"?0:1;if(119808<=s&&s<120484){var m=Math.floor((s-119808)/26);return[ye[m][2],ye[m][o]]}else if(120782<=s&&s<=120831){var c=Math.floor((s-120782)/10);return[Xt[c][2],Xt[c][o]]}else{if(s===120485||s===120486)return[ye[0][2],ye[0][o]];if(120486<s&&s<120782)return["",""];throw new M("Unsupported character: "+e)}},Ie=function(e,t,a){return $[a][e]&&$[a][e].replace&&(e=$[a][e].replace),{value:e,metrics:pt(e,t,a)}},b0=function(e,t,a,i,s){var o=Ie(e,t,a),m=o.metrics;e=o.value;var c;if(m){var p=m.italic;(a==="text"||i&&i.font==="mathit")&&(p=0),c=new p0(e,m.height,m.depth,p,m.skew,m.width,s)}else typeof console<"u"&&console.warn("No character metrics "+("for '"+e+"' in style '"+t+"' and mode '"+a+"'")),c=new p0(e,0,0,0,0,0,s);if(i){c.maxFontSize=i.sizeMultiplier,i.style.isTight()&&c.classes.push("mtight");var g=i.getColor();g&&(c.style.color=g)}return c},Qa=function(e,t,a,i){return i===void 0&&(i=[]),a.font==="boldsymbol"&&Ie(e,"Main-Bold",t).metrics?b0(e,"Main-Bold",t,a,i.concat(["mathbf"])):e==="\\"||$[t][e].font==="main"?b0(e,"Main-Regular",t,a,i):b0(e,"AMS-Regular",t,a,i.concat(["amsrm"]))},_a=function(e,t,a,i,s){return s!=="textord"&&Ie(e,"Math-BoldItalic",t).metrics?{fontName:"Math-BoldItalic",fontClass:"boldsymbol"}:{fontName:"Main-Bold",fontClass:"mathbf"}},e1=function(e,t,a){var i=e.mode,s=e.text,o=["mord"],m=i==="math"||i==="text"&&t.font,c=m?t.font:t.fontFamily,p="",g="";if(s.charCodeAt(0)===55349&&([p,g]=Ja(s,i)),p.length>0)return b0(s,p,i,t,o.concat(g));if(c){var y,w;if(c==="boldsymbol"){var x=_a(s,i,t,o,a);y=x.fontName,w=[x.fontClass]}else m?(y=zr[c].fontName,w=[c]):(y=we(c,t.fontWeight,t.fontShape),w=[c,t.fontWeight,t.fontShape]);if(Ie(s,y,i).metrics)return b0(s,y,i,t,o.concat(w));if(kr.hasOwnProperty(s)&&y.slice(0,10)==="Typewriter"){for(var z=[],A=0;A<s.length;A++)z.push(b0(s[A],y,i,t,o.concat(w)));return Mr(z)}}if(a==="mathord")return b0(s,"Math-Italic",i,t,o.concat(["mathnormal"]));if(a==="textord"){var C=$[i][s]&&$[i][s].font;if(C==="ams"){var q=we("amsrm",t.fontWeight,t.fontShape);return b0(s,q,i,t,o.concat("amsrm",t.fontWeight,t.fontShape))}else if(C==="main"||!C){var E=we("textrm",t.fontWeight,t.fontShape);return b0(s,E,i,t,o.concat(t.fontWeight,t.fontShape))}else{var O=we(C,t.fontWeight,t.fontShape);return b0(s,O,i,t,o.concat(O,t.fontWeight,t.fontShape))}}else throw new Error("unexpected type: "+a+" in makeOrd")},t1=(r,e)=>{if(P0(r.classes)!==P0(e.classes)||r.skew!==e.skew||r.maxFontSize!==e.maxFontSize)return!1;if(r.classes.length===1){var t=r.classes[0];if(t==="mbin"||t==="mord")return!1}for(var a in r.style)if(r.style.hasOwnProperty(a)&&r.style[a]!==e.style[a])return!1;for(var i in e.style)if(e.style.hasOwnProperty(i)&&r.style[i]!==e.style[i])return!1;return!0},r1=r=>{for(var e=0;e<r.length-1;e++){var t=r[e],a=r[e+1];t instanceof p0&&a instanceof p0&&t1(t,a)&&(t.text+=a.text,t.height=Math.max(t.height,a.height),t.depth=Math.max(t.depth,a.depth),t.italic=a.italic,r.splice(e+1,1),e--)}return r},gt=function(e){for(var t=0,a=0,i=0,s=0;s<e.children.length;s++){var o=e.children[s];o.height>t&&(t=o.height),o.depth>a&&(a=o.depth),o.maxFontSize>i&&(i=o.maxFontSize)}e.height=t,e.depth=a,e.maxFontSize=i},l0=function(e,t,a,i){var s=new me(e,t,a,i);return gt(s),s},Sr=(r,e,t,a)=>new me(r,e,t,a),a1=function(e,t,a){var i=l0([e],[],t);return i.height=Math.max(a||t.fontMetrics().defaultRuleThickness,t.minRuleThickness),i.style.borderBottomWidth=T(i.height),i.maxFontSize=1,i},i1=function(e,t,a,i){var s=new vt(e,t,a,i);return gt(s),s},Mr=function(e){var t=new he(e);return gt(t),t},n1=function(e,t){return e instanceof he?l0([],[e],t):e},s1=function(e){if(e.positionType==="individualShift"){for(var t=e.children,a=[t[0]],i=-t[0].shift-t[0].elem.depth,s=i,o=1;o<t.length;o++){var m=-t[o].shift-s-t[o].elem.depth,c=m-(t[o-1].elem.height+t[o-1].elem.depth);s=s+m,a.push({type:"kern",size:c}),a.push(t[o])}return{children:a,depth:i}}var p;if(e.positionType==="top"){for(var g=e.positionData,y=0;y<e.children.length;y++){var w=e.children[y];g-=w.type==="kern"?w.size:w.elem.height+w.elem.depth}p=g}else if(e.positionType==="bottom")p=-e.positionData;else{var x=e.children[0];if(x.type!=="elem")throw new Error('First child must have type "elem".');if(e.positionType==="shift")p=-x.elem.depth-e.positionData;else if(e.positionType==="firstBaseline")p=-x.elem.depth;else throw new Error("Invalid positionType "+e.positionType+".")}return{children:e.children,depth:p}},l1=function(e,t){for(var{children:a,depth:i}=s1(e),s=0,o=0;o<a.length;o++){var m=a[o];if(m.type==="elem"){var c=m.elem;s=Math.max(s,c.maxFontSize,c.height)}}s+=2;var p=l0(["pstrut"],[]);p.style.height=T(s);for(var g=[],y=i,w=i,x=i,z=0;z<a.length;z++){var A=a[z];if(A.type==="kern")x+=A.size;else{var C=A.elem,q=A.wrapperClasses||[],E=A.wrapperStyle||{},O=l0(q,[p,C],void 0,E);O.style.top=T(-s-x-C.depth),A.marginLeft&&(O.style.marginLeft=A.marginLeft),A.marginRight&&(O.style.marginRight=A.marginRight),g.push(O),x+=C.height+C.depth}y=Math.min(y,x),w=Math.max(w,x)}var G=l0(["vlist"],g);G.style.height=T(w);var L;if(y<0){var U=l0([],[]),P=l0(["vlist"],[U]);P.style.height=T(-y);var j=l0(["vlist-s"],[new p0("​")]);L=[l0(["vlist-r"],[G,j]),l0(["vlist-r"],[P])]}else L=[l0(["vlist-r"],[G])];var Y=l0(["vlist-t"],L);return L.length===2&&Y.classes.push("vlist-t2"),Y.height=w,Y.depth=-y,Y},o1=(r,e)=>{var t=l0(["mspace"],[],e),a=K(r,e);return t.style.marginRight=T(a),t},we=function(e,t,a){var i="";switch(e){case"amsrm":i="AMS";break;case"textrm":i="Main";break;case"textsf":i="SansSerif";break;case"texttt":i="Typewriter";break;default:i=e}var s;return t==="textbf"&&a==="textit"?s="BoldItalic":t==="textbf"?s="Bold":t==="textit"?s="Italic":s="Regular",i+"-"+s},zr={mathbf:{variant:"bold",fontName:"Main-Bold"},mathrm:{variant:"normal",fontName:"Main-Regular"},textit:{variant:"italic",fontName:"Main-Italic"},mathit:{variant:"italic",fontName:"Main-Italic"},mathnormal:{variant:"italic",fontName:"Math-Italic"},mathsfit:{variant:"sans-serif-italic",fontName:"SansSerif-Italic"},mathbb:{variant:"double-struck",fontName:"AMS-Regular"},mathcal:{variant:"script",fontName:"Caligraphic-Regular"},mathfrak:{variant:"fraktur",fontName:"Fraktur-Regular"},mathscr:{variant:"script",fontName:"Script-Regular"},mathsf:{variant:"sans-serif",fontName:"SansSerif-Regular"},mathtt:{variant:"monospace",fontName:"Typewriter-Regular"}},Tr={vec:["vec",.471,.714],oiintSize1:["oiintSize1",.957,.499],oiintSize2:["oiintSize2",1.472,.659],oiiintSize1:["oiiintSize1",1.304,.499],oiiintSize2:["oiiintSize2",1.98,.659]},h1=function(e,t){var[a,i,s]=Tr[e],o=new V0(a),m=new C0([o],{width:T(i),height:T(s),style:"width:"+T(i),viewBox:"0 0 "+1e3*i+" "+1e3*s,preserveAspectRatio:"xMinYMin"}),c=Sr(["overlay"],[m],t);return c.height=s,c.style.height=T(s),c.style.width=T(i),c},b={fontMap:zr,makeSymbol:b0,mathsym:Qa,makeSpan:l0,makeSvgSpan:Sr,makeLineSpan:a1,makeAnchor:i1,makeFragment:Mr,wrapFragment:n1,makeVList:l1,makeOrd:e1,makeGlue:o1,staticSvg:h1,svgData:Tr,tryCombineChars:r1},Z={number:3,unit:"mu"},$0={number:4,unit:"mu"},T0={number:5,unit:"mu"},m1={mord:{mop:Z,mbin:$0,mrel:T0,minner:Z},mop:{mord:Z,mop:Z,mrel:T0,minner:Z},mbin:{mord:$0,mop:$0,mopen:$0,minner:$0},mrel:{mord:T0,mop:T0,mopen:T0,minner:T0},mopen:{},mclose:{mop:Z,mbin:$0,mrel:T0,minner:Z},mpunct:{mord:Z,mop:Z,mrel:T0,mopen:Z,mclose:Z,mpunct:Z,minner:Z},minner:{mord:Z,mop:Z,mbin:$0,mrel:T0,mopen:Z,mpunct:Z,minner:Z}},u1={mord:{mop:Z},mop:{mord:Z,mop:Z},mbin:{},mrel:{},mopen:{},mclose:{mop:Z},mpunct:{},minner:{mop:Z}},Ar={},Ne={},Ce={};function B(r){for(var{type:e,names:t,props:a,handler:i,htmlBuilder:s,mathmlBuilder:o}=r,m={type:e,numArgs:a.numArgs,argTypes:a.argTypes,allowedInArgument:!!a.allowedInArgument,allowedInText:!!a.allowedInText,allowedInMath:a.allowedInMath===void 0?!0:a.allowedInMath,numOptionalArgs:a.numOptionalArgs||0,infix:!!a.infix,primitive:!!a.primitive,handler:i},c=0;c<t.length;++c)Ar[t[c]]=m;e&&(s&&(Ne[e]=s),o&&(Ce[e]=o))}function W0(r){var{type:e,htmlBuilder:t,mathmlBuilder:a}=r;B({type:e,names:[],props:{numArgs:0},handler(){throw new Error("Should never be called.")},htmlBuilder:t,mathmlBuilder:a})}var qe=function(e){return e.type==="ordgroup"&&e.body.length===1?e.body[0]:e},Q=function(e){return e.type==="ordgroup"?e.body:[e]},q0=b.makeSpan,c1=["leftmost","mbin","mopen","mrel","mop","mpunct"],d1=["rightmost","mrel","mclose","mpunct"],f1={display:I.DISPLAY,text:I.TEXT,script:I.SCRIPT,scriptscript:I.SCRIPTSCRIPT},p1={mord:"mord",mop:"mop",mbin:"mbin",mrel:"mrel",mopen:"mopen",mclose:"mclose",mpunct:"mpunct",minner:"minner"},t0=function(e,t,a,i){i===void 0&&(i=[null,null]);for(var s=[],o=0;o<e.length;o++){var m=F(e[o],t);if(m instanceof he){var c=m.children;s.push(...c)}else s.push(m)}if(b.tryCombineChars(s),!a)return s;var p=t;if(e.length===1){var g=e[0];g.type==="sizing"?p=t.havingSize(g.size):g.type==="styling"&&(p=t.havingStyle(f1[g.style]))}var y=q0([i[0]||"leftmost"],[],t),w=q0([i[1]||"rightmost"],[],t),x=a==="root";return $t(s,(z,A)=>{var C=A.classes[0],q=z.classes[0];C==="mbin"&&d1.includes(q)?A.classes[0]="mord":q==="mbin"&&c1.includes(C)&&(z.classes[0]="mord")},{node:y},w,x),$t(s,(z,A)=>{var C=ot(A),q=ot(z),E=C&&q?z.hasClass("mtight")?u1[C][q]:m1[C][q]:null;if(E)return b.makeGlue(E,p)},{node:y},w,x),s},$t=function r(e,t,a,i,s){i&&e.push(i);for(var o=0;o<e.length;o++){var m=e[o],c=Br(m);if(c){r(c.children,t,a,null,s);continue}var p=!m.hasClass("mspace");if(p){var g=t(m,a.node);g&&(a.insertAfter?a.insertAfter(g):(e.unshift(g),o++))}p?a.node=m:s&&m.hasClass("newline")&&(a.node=q0(["leftmost"])),a.insertAfter=(y=>w=>{e.splice(y+1,0,w),o++})(o)}i&&e.pop()},Br=function(e){return e instanceof he||e instanceof vt||e instanceof me&&e.hasClass("enclosing")?e:null},v1=function r(e,t){var a=Br(e);if(a){var i=a.children;if(i.length){if(t==="right")return r(i[i.length-1],"right");if(t==="left")return r(i[0],"left")}}return e},ot=function(e,t){return e?(t&&(e=v1(e,t)),p1[e.classes[0]]||null):null},oe=function(e,t){var a=["nulldelimiter"].concat(e.baseSizingClasses());return q0(t.concat(a))},F=function(e,t,a){if(!e)return q0();if(Ne[e.type]){var i=Ne[e.type](e,t);if(a&&t.size!==a.size){i=q0(t.sizingClasses(a),[i],t);var s=t.sizeMultiplier/a.sizeMultiplier;i.height*=s,i.depth*=s}return i}else throw new M("Got group of unknown type: '"+e.type+"'")};function xe(r,e){var t=q0(["base"],r,e),a=q0(["strut"]);return a.style.height=T(t.height+t.depth),t.depth&&(a.style.verticalAlign=T(-t.depth)),t.children.unshift(a),t}function ht(r,e){var t=null;r.length===1&&r[0].type==="tag"&&(t=r[0].tag,r=r[0].body);var a=t0(r,e,"root"),i;a.length===2&&a[1].hasClass("tag")&&(i=a.pop());for(var s=[],o=[],m=0;m<a.length;m++)if(o.push(a[m]),a[m].hasClass("mbin")||a[m].hasClass("mrel")||a[m].hasClass("allowbreak")){for(var c=!1;m<a.length-1&&a[m+1].hasClass("mspace")&&!a[m+1].hasClass("newline");)m++,o.push(a[m]),a[m].hasClass("nobreak")&&(c=!0);c||(s.push(xe(o,e)),o=[])}else a[m].hasClass("newline")&&(o.pop(),o.length>0&&(s.push(xe(o,e)),o=[]),s.push(a[m]));o.length>0&&s.push(xe(o,e));var p;t?(p=xe(t0(t,e,!0)),p.classes=["tag"],s.push(p)):i&&s.push(i);var g=q0(["katex-html"],s);if(g.setAttribute("aria-hidden","true"),p){var y=p.children[0];y.style.height=T(g.height+g.depth),g.depth&&(y.style.verticalAlign=T(-g.depth))}return g}function Nr(r){return new he(r)}class m0{constructor(e,t,a){this.type=void 0,this.attributes=void 0,this.children=void 0,this.classes=void 0,this.type=e,this.attributes={},this.children=t||[],this.classes=a||[]}setAttribute(e,t){this.attributes[e]=t}getAttribute(e){return this.attributes[e]}toNode(){var e=document.createElementNS("http://www.w3.org/1998/Math/MathML",this.type);for(var t in this.attributes)Object.prototype.hasOwnProperty.call(this.attributes,t)&&e.setAttribute(t,this.attributes[t]);this.classes.length>0&&(e.className=P0(this.classes));for(var a=0;a<this.children.length;a++)if(this.children[a]instanceof x0&&this.children[a+1]instanceof x0){for(var i=this.children[a].toText()+this.children[++a].toText();this.children[a+1]instanceof x0;)i+=this.children[++a].toText();e.appendChild(new x0(i).toNode())}else e.appendChild(this.children[a].toNode());return e}toMarkup(){var e="<"+this.type;for(var t in this.attributes)Object.prototype.hasOwnProperty.call(this.attributes,t)&&(e+=" "+t+'="',e+=V.escape(this.attributes[t]),e+='"');this.classes.length>0&&(e+=' class ="'+V.escape(P0(this.classes))+'"'),e+=">";for(var a=0;a<this.children.length;a++)e+=this.children[a].toMarkup();return e+="</"+this.type+">",e}toText(){return this.children.map(e=>e.toText()).join("")}}class x0{constructor(e){this.text=void 0,this.text=e}toNode(){return document.createTextNode(this.text)}toMarkup(){return V.escape(this.toText())}toText(){return this.text}}class g1{constructor(e){this.width=void 0,this.character=void 0,this.width=e,e>=.05555&&e<=.05556?this.character=" ":e>=.1666&&e<=.1667?this.character=" ":e>=.2222&&e<=.2223?this.character=" ":e>=.2777&&e<=.2778?this.character="  ":e>=-.05556&&e<=-.05555?this.character=" ⁣":e>=-.1667&&e<=-.1666?this.character=" ⁣":e>=-.2223&&e<=-.2222?this.character=" ⁣":e>=-.2778&&e<=-.2777?this.character=" ⁣":this.character=null}toNode(){if(this.character)return document.createTextNode(this.character);var e=document.createElementNS("http://www.w3.org/1998/Math/MathML","mspace");return e.setAttribute("width",T(this.width)),e}toMarkup(){return this.character?"<mtext>"+this.character+"</mtext>":'<mspace width="'+T(this.width)+'"/>'}toText(){return this.character?this.character:" "}}var S={MathNode:m0,TextNode:x0,SpaceNode:g1,newDocumentFragment:Nr},v0=function(e,t,a){return $[t][e]&&$[t][e].replace&&e.charCodeAt(0)!==55349&&!(kr.hasOwnProperty(e)&&a&&(a.fontFamily&&a.fontFamily.slice(4,6)==="tt"||a.font&&a.font.slice(4,6)==="tt"))&&(e=$[t][e].replace),new S.TextNode(e)},bt=function(e){return e.length===1?e[0]:new S.MathNode("mrow",e)},yt=function(e,t){if(t.fontFamily==="texttt")return"monospace";if(t.fontFamily==="textsf")return t.fontShape==="textit"&&t.fontWeight==="textbf"?"sans-serif-bold-italic":t.fontShape==="textit"?"sans-serif-italic":t.fontWeight==="textbf"?"bold-sans-serif":"sans-serif";if(t.fontShape==="textit"&&t.fontWeight==="textbf")return"bold-italic";if(t.fontShape==="textit")return"italic";if(t.fontWeight==="textbf")return"bold";var a=t.font;if(!a||a==="mathnormal")return null;var i=e.mode;if(a==="mathit")return"italic";if(a==="boldsymbol")return e.type==="textord"?"bold":"bold-italic";if(a==="mathbf")return"bold";if(a==="mathbb")return"double-struck";if(a==="mathsfit")return"sans-serif-italic";if(a==="mathfrak")return"fraktur";if(a==="mathscr"||a==="mathcal")return"script";if(a==="mathsf")return"sans-serif";if(a==="mathtt")return"monospace";var s=e.text;if(["\\imath","\\jmath"].includes(s))return null;$[i][s]&&$[i][s].replace&&(s=$[i][s].replace);var o=b.fontMap[a].fontName;return pt(s,o,i)?b.fontMap[a].variant:null};function je(r){if(!r)return!1;if(r.type==="mi"&&r.children.length===1){var e=r.children[0];return e instanceof x0&&e.text==="."}else if(r.type==="mo"&&r.children.length===1&&r.getAttribute("separator")==="true"&&r.getAttribute("lspace")==="0em"&&r.getAttribute("rspace")==="0em"){var t=r.children[0];return t instanceof x0&&t.text===","}else return!1}var h0=function(e,t,a){if(e.length===1){var i=X(e[0],t);return a&&i instanceof m0&&i.type==="mo"&&(i.setAttribute("lspace","0em"),i.setAttribute("rspace","0em")),[i]}for(var s=[],o,m=0;m<e.length;m++){var c=X(e[m],t);if(c instanceof m0&&o instanceof m0){if(c.type==="mtext"&&o.type==="mtext"&&c.getAttribute("mathvariant")===o.getAttribute("mathvariant")){o.children.push(...c.children);continue}else if(c.type==="mn"&&o.type==="mn"){o.children.push(...c.children);continue}else if(je(c)&&o.type==="mn"){o.children.push(...c.children);continue}else if(c.type==="mn"&&je(o))c.children=[...o.children,...c.children],s.pop();else if((c.type==="msup"||c.type==="msub")&&c.children.length>=1&&(o.type==="mn"||je(o))){var p=c.children[0];p instanceof m0&&p.type==="mn"&&(p.children=[...o.children,...p.children],s.pop())}else if(o.type==="mi"&&o.children.length===1){var g=o.children[0];if(g instanceof x0&&g.text==="̸"&&(c.type==="mo"||c.type==="mi"||c.type==="mn")){var y=c.children[0];y instanceof x0&&y.text.length>0&&(y.text=y.text.slice(0,1)+"̸"+y.text.slice(1),s.pop())}}}s.push(c),o=c}return s},G0=function(e,t,a){return bt(h0(e,t,a))},X=function(e,t){if(!e)return new S.MathNode("mrow");if(Ce[e.type]){var a=Ce[e.type](e,t);return a}else throw new M("Got group of unknown type: '"+e.type+"'")};function Wt(r,e,t,a,i){var s=h0(r,t),o;s.length===1&&s[0]instanceof m0&&["mrow","mtable"].includes(s[0].type)?o=s[0]:o=new S.MathNode("mrow",s);var m=new S.MathNode("annotation",[new S.TextNode(e)]);m.setAttribute("encoding","application/x-tex");var c=new S.MathNode("semantics",[o,m]),p=new S.MathNode("math",[c]);p.setAttribute("xmlns","http://www.w3.org/1998/Math/MathML"),a&&p.setAttribute("display","block");var g=i?"katex":"katex-mathml";return b.makeSpan([g],[p])}var Cr=function(e){return new A0({style:e.displayMode?I.DISPLAY:I.TEXT,maxSize:e.maxSize,minRuleThickness:e.minRuleThickness})},qr=function(e,t){if(t.displayMode){var a=["katex-display"];t.leqno&&a.push("leqno"),t.fleqn&&a.push("fleqn"),e=b.makeSpan(a,[e])}return e},b1=function(e,t,a){var i=Cr(a),s;if(a.output==="mathml")return Wt(e,t,i,a.displayMode,!0);if(a.output==="html"){var o=ht(e,i);s=b.makeSpan(["katex"],[o])}else{var m=Wt(e,t,i,a.displayMode,!1),c=ht(e,i);s=b.makeSpan(["katex"],[m,c])}return qr(s,a)},y1=function(e,t,a){var i=Cr(a),s=ht(e,i),o=b.makeSpan(["katex"],[s]);return qr(o,a)},w1={widehat:"^",widecheck:"ˇ",widetilde:"~",utilde:"~",overleftarrow:"←",underleftarrow:"←",xleftarrow:"←",overrightarrow:"→",underrightarrow:"→",xrightarrow:"→",underbrace:"⏟",overbrace:"⏞",overgroup:"⏠",undergroup:"⏡",overleftrightarrow:"↔",underleftrightarrow:"↔",xleftrightarrow:"↔",Overrightarrow:"⇒",xRightarrow:"⇒",overleftharpoon:"↼",xleftharpoonup:"↼",overrightharpoon:"⇀",xrightharpoonup:"⇀",xLeftarrow:"⇐",xLeftrightarrow:"⇔",xhookleftarrow:"↩",xhookrightarrow:"↪",xmapsto:"↦",xrightharpoondown:"⇁",xleftharpoondown:"↽",xrightleftharpoons:"⇌",xleftrightharpoons:"⇋",xtwoheadleftarrow:"↞",xtwoheadrightarrow:"↠",xlongequal:"=",xtofrom:"⇄",xrightleftarrows:"⇄",xrightequilibrium:"⇌",xleftequilibrium:"⇋","\\cdrightarrow":"→","\\cdleftarrow":"←","\\cdlongequal":"="},x1=function(e){var t=new S.MathNode("mo",[new S.TextNode(w1[e.replace(/^\\/,"")])]);return t.setAttribute("stretchy","true"),t},k1={overrightarrow:[["rightarrow"],.888,522,"xMaxYMin"],overleftarrow:[["leftarrow"],.888,522,"xMinYMin"],underrightarrow:[["rightarrow"],.888,522,"xMaxYMin"],underleftarrow:[["leftarrow"],.888,522,"xMinYMin"],xrightarrow:[["rightarrow"],1.469,522,"xMaxYMin"],"\\cdrightarrow":[["rightarrow"],3,522,"xMaxYMin"],xleftarrow:[["leftarrow"],1.469,522,"xMinYMin"],"\\cdleftarrow":[["leftarrow"],3,522,"xMinYMin"],Overrightarrow:[["doublerightarrow"],.888,560,"xMaxYMin"],xRightarrow:[["doublerightarrow"],1.526,560,"xMaxYMin"],xLeftarrow:[["doubleleftarrow"],1.526,560,"xMinYMin"],overleftharpoon:[["leftharpoon"],.888,522,"xMinYMin"],xleftharpoonup:[["leftharpoon"],.888,522,"xMinYMin"],xleftharpoondown:[["leftharpoondown"],.888,522,"xMinYMin"],overrightharpoon:[["rightharpoon"],.888,522,"xMaxYMin"],xrightharpoonup:[["rightharpoon"],.888,522,"xMaxYMin"],xrightharpoondown:[["rightharpoondown"],.888,522,"xMaxYMin"],xlongequal:[["longequal"],.888,334,"xMinYMin"],"\\cdlongequal":[["longequal"],3,334,"xMinYMin"],xtwoheadleftarrow:[["twoheadleftarrow"],.888,334,"xMinYMin"],xtwoheadrightarrow:[["twoheadrightarrow"],.888,334,"xMaxYMin"],overleftrightarrow:[["leftarrow","rightarrow"],.888,522],overbrace:[["leftbrace","midbrace","rightbrace"],1.6,548],underbrace:[["leftbraceunder","midbraceunder","rightbraceunder"],1.6,548],underleftrightarrow:[["leftarrow","rightarrow"],.888,522],xleftrightarrow:[["leftarrow","rightarrow"],1.75,522],xLeftrightarrow:[["doubleleftarrow","doublerightarrow"],1.75,560],xrightleftharpoons:[["leftharpoondownplus","rightharpoonplus"],1.75,716],xleftrightharpoons:[["leftharpoonplus","rightharpoondownplus"],1.75,716],xhookleftarrow:[["leftarrow","righthook"],1.08,522],xhookrightarrow:[["lefthook","rightarrow"],1.08,522],overlinesegment:[["leftlinesegment","rightlinesegment"],.888,522],underlinesegment:[["leftlinesegment","rightlinesegment"],.888,522],overgroup:[["leftgroup","rightgroup"],.888,342],undergroup:[["leftgroupunder","rightgroupunder"],.888,342],xmapsto:[["leftmapsto","rightarrow"],1.5,522],xtofrom:[["leftToFrom","rightToFrom"],1.75,528],xrightleftarrows:[["baraboveleftarrow","rightarrowabovebar"],1.75,901],xrightequilibrium:[["baraboveshortleftharpoon","rightharpoonaboveshortbar"],1.75,716],xleftequilibrium:[["shortbaraboveleftharpoon","shortrightharpoonabovebar"],1.75,716]},S1=function(e){return e.type==="ordgroup"?e.body.length:1},M1=function(e,t){function a(){var m=4e5,c=e.label.slice(1);if(["widehat","widecheck","widetilde","utilde"].includes(c)){var p=e,g=S1(p.base),y,w,x;if(g>5)c==="widehat"||c==="widecheck"?(y=420,m=2364,x=.42,w=c+"4"):(y=312,m=2340,x=.34,w="tilde4");else{var z=[1,1,2,2,3,3][g];c==="widehat"||c==="widecheck"?(m=[0,1062,2364,2364,2364][z],y=[0,239,300,360,420][z],x=[0,.24,.3,.3,.36,.42][z],w=c+z):(m=[0,600,1033,2339,2340][z],y=[0,260,286,306,312][z],x=[0,.26,.286,.3,.306,.34][z],w="tilde"+z)}var A=new V0(w),C=new C0([A],{width:"100%",height:T(x),viewBox:"0 0 "+m+" "+y,preserveAspectRatio:"none"});return{span:b.makeSvgSpan([],[C],t),minWidth:0,height:x}}else{var q=[],E=k1[c],[O,G,L]=E,U=L/1e3,P=O.length,j,Y;if(P===1){var z0=E[3];j=["hide-tail"],Y=[z0]}else if(P===2)j=["halfarrow-left","halfarrow-right"],Y=["xMinYMin","xMaxYMin"];else if(P===3)j=["brace-left","brace-center","brace-right"],Y=["xMinYMin","xMidYMin","xMaxYMin"];else throw new Error(`Correct katexImagesData or update code here to support
                    `+P+" children.");for(var r0=0;r0<P;r0++){var e0=new V0(O[r0]),Y0=new C0([e0],{width:"400em",height:T(U),viewBox:"0 0 "+m+" "+L,preserveAspectRatio:Y[r0]+" slice"}),s0=b.makeSvgSpan([j[r0]],[Y0],t);if(P===1)return{span:s0,minWidth:G,height:U};s0.style.height=T(U),q.push(s0)}return{span:b.makeSpan(["stretchy"],q,t),minWidth:G,height:U}}}var{span:i,minWidth:s,height:o}=a();return i.height=o,i.style.height=T(o),s>0&&(i.style.minWidth=T(s)),i},z1=function(e,t,a,i,s){var o,m=e.height+e.depth+a+i;if(/fbox|color|angl/.test(t)){if(o=b.makeSpan(["stretchy",t],[],s),t==="fbox"){var c=s.color&&s.getColor();c&&(o.style.borderColor=c)}}else{var p=[];/^[bx]cancel$/.test(t)&&p.push(new st({x1:"0",y1:"0",x2:"100%",y2:"100%","stroke-width":"0.046em"})),/^x?cancel$/.test(t)&&p.push(new st({x1:"0",y1:"100%",x2:"100%",y2:"0","stroke-width":"0.046em"}));var g=new C0(p,{width:"100%",height:T(m)});o=b.makeSvgSpan([],[g],s)}return o.height=m,o.style.height=T(m),o},R0={encloseSpan:z1,mathMLnode:x1,svgSpan:M1};function H(r,e){if(!r||r.type!==e)throw new Error("Expected node of type "+e+", but got "+(r?"node of type "+r.type:String(r)));return r}function wt(r){var e=De(r);if(!e)throw new Error("Expected node of symbol group type, but got "+(r?"node of type "+r.type:String(r)));return e}function De(r){return r&&(r.type==="atom"||Ka.hasOwnProperty(r.type))?r:null}var xt=(r,e)=>{var t,a,i;r&&r.type==="supsub"?(a=H(r.base,"accent"),t=a.base,r.base=t,i=ja(F(r,e)),r.base=a):(a=H(r,"accent"),t=a.base);var s=F(t,e.havingCrampedStyle()),o=a.isShifty&&V.isCharacterBox(t),m=0;if(o){var c=V.getBaseElem(t),p=F(c,e.havingCrampedStyle());m=Pt(p).skew}var g=a.label==="\\c",y=g?s.height+s.depth:Math.min(s.height,e.fontMetrics().xHeight),w;if(a.isStretchy)w=R0.svgSpan(a,e),w=b.makeVList({positionType:"firstBaseline",children:[{type:"elem",elem:s},{type:"elem",elem:w,wrapperClasses:["svg-align"],wrapperStyle:m>0?{width:"calc(100% - "+T(2*m)+")",marginLeft:T(2*m)}:void 0}]},e);else{var x,z;a.label==="\\vec"?(x=b.staticSvg("vec",e),z=b.svgData.vec[1]):(x=b.makeOrd({mode:a.mode,text:a.label},e,"textord"),x=Pt(x),x.italic=0,z=x.width,g&&(y+=x.depth)),w=b.makeSpan(["accent-body"],[x]);var A=a.label==="\\textcircled";A&&(w.classes.push("accent-full"),y=s.height);var C=m;A||(C-=z/2),w.style.left=T(C),a.label==="\\textcircled"&&(w.style.top=".2em"),w=b.makeVList({positionType:"firstBaseline",children:[{type:"elem",elem:s},{type:"kern",size:-y},{type:"elem",elem:w}]},e)}var q=b.makeSpan(["mord","accent"],[w],e);return i?(i.children[0]=q,i.height=Math.max(q.height,i.height),i.classes[0]="mord",i):q},Rr=(r,e)=>{var t=r.isStretchy?R0.mathMLnode(r.label):new S.MathNode("mo",[v0(r.label,r.mode)]),a=new S.MathNode("mover",[X(r.base,e),t]);return a.setAttribute("accent","true"),a},T1=new RegExp(["\\acute","\\grave","\\ddot","\\tilde","\\bar","\\breve","\\check","\\hat","\\vec","\\dot","\\mathring"].map(r=>"\\"+r).join("|"));B({type:"accent",names:["\\acute","\\grave","\\ddot","\\tilde","\\bar","\\breve","\\check","\\hat","\\vec","\\dot","\\mathring","\\widecheck","\\widehat","\\widetilde","\\overrightarrow","\\overleftarrow","\\Overrightarrow","\\overleftrightarrow","\\overgroup","\\overlinesegment","\\overleftharpoon","\\overrightharpoon"],props:{numArgs:1},handler:(r,e)=>{var t=qe(e[0]),a=!T1.test(r.funcName),i=!a||r.funcName==="\\widehat"||r.funcName==="\\widetilde"||r.funcName==="\\widecheck";return{type:"accent",mode:r.parser.mode,label:r.funcName,isStretchy:a,isShifty:i,base:t}},htmlBuilder:xt,mathmlBuilder:Rr});B({type:"accent",names:["\\'","\\`","\\^","\\~","\\=","\\u","\\.",'\\"',"\\c","\\r","\\H","\\v","\\textcircled"],props:{numArgs:1,allowedInText:!0,allowedInMath:!0,argTypes:["primitive"]},handler:(r,e)=>{var t=e[0],a=r.parser.mode;return a==="math"&&(r.parser.settings.reportNonstrict("mathVsTextAccents","LaTeX's accent "+r.funcName+" works only in text mode"),a="text"),{type:"accent",mode:a,label:r.funcName,isStretchy:!1,isShifty:!0,base:t}},htmlBuilder:xt,mathmlBuilder:Rr});B({type:"accentUnder",names:["\\underleftarrow","\\underrightarrow","\\underleftrightarrow","\\undergroup","\\underlinesegment","\\utilde"],props:{numArgs:1},handler:(r,e)=>{var{parser:t,funcName:a}=r,i=e[0];return{type:"accentUnder",mode:t.mode,label:a,base:i}},htmlBuilder:(r,e)=>{var t=F(r.base,e),a=R0.svgSpan(r,e),i=r.label==="\\utilde"?.12:0,s=b.makeVList({positionType:"top",positionData:t.height,children:[{type:"elem",elem:a,wrapperClasses:["svg-align"]},{type:"kern",size:i},{type:"elem",elem:t}]},e);return b.makeSpan(["mord","accentunder"],[s],e)},mathmlBuilder:(r,e)=>{var t=R0.mathMLnode(r.label),a=new S.MathNode("munder",[X(r.base,e),t]);return a.setAttribute("accentunder","true"),a}});var ke=r=>{var e=new S.MathNode("mpadded",r?[r]:[]);return e.setAttribute("width","+0.6em"),e.setAttribute("lspace","0.3em"),e};B({type:"xArrow",names:["\\xleftarrow","\\xrightarrow","\\xLeftarrow","\\xRightarrow","\\xleftrightarrow","\\xLeftrightarrow","\\xhookleftarrow","\\xhookrightarrow","\\xmapsto","\\xrightharpoondown","\\xrightharpoonup","\\xleftharpoondown","\\xleftharpoonup","\\xrightleftharpoons","\\xleftrightharpoons","\\xlongequal","\\xtwoheadrightarrow","\\xtwoheadleftarrow","\\xtofrom","\\xrightleftarrows","\\xrightequilibrium","\\xleftequilibrium","\\\\cdrightarrow","\\\\cdleftarrow","\\\\cdlongequal"],props:{numArgs:1,numOptionalArgs:1},handler(r,e,t){var{parser:a,funcName:i}=r;return{type:"xArrow",mode:a.mode,label:i,body:e[0],below:t[0]}},htmlBuilder(r,e){var t=e.style,a=e.havingStyle(t.sup()),i=b.wrapFragment(F(r.body,a,e),e),s=r.label.slice(0,2)==="\\x"?"x":"cd";i.classes.push(s+"-arrow-pad");var o;r.below&&(a=e.havingStyle(t.sub()),o=b.wrapFragment(F(r.below,a,e),e),o.classes.push(s+"-arrow-pad"));var m=R0.svgSpan(r,e),c=-e.fontMetrics().axisHeight+.5*m.height,p=-e.fontMetrics().axisHeight-.5*m.height-.111;(i.depth>.25||r.label==="\\xleftequilibrium")&&(p-=i.depth);var g;if(o){var y=-e.fontMetrics().axisHeight+o.height+.5*m.height+.111;g=b.makeVList({positionType:"individualShift",children:[{type:"elem",elem:i,shift:p},{type:"elem",elem:m,shift:c},{type:"elem",elem:o,shift:y}]},e)}else g=b.makeVList({positionType:"individualShift",children:[{type:"elem",elem:i,shift:p},{type:"elem",elem:m,shift:c}]},e);return g.children[0].children[0].children[1].classes.push("svg-align"),b.makeSpan(["mrel","x-arrow"],[g],e)},mathmlBuilder(r,e){var t=R0.mathMLnode(r.label);t.setAttribute("minsize",r.label.charAt(0)==="x"?"1.75em":"3.0em");var a;if(r.body){var i=ke(X(r.body,e));if(r.below){var s=ke(X(r.below,e));a=new S.MathNode("munderover",[t,s,i])}else a=new S.MathNode("mover",[t,i])}else if(r.below){var o=ke(X(r.below,e));a=new S.MathNode("munder",[t,o])}else a=ke(),a=new S.MathNode("mover",[t,a]);return a}});var A1=b.makeSpan;function Ir(r,e){var t=t0(r.body,e,!0);return A1([r.mclass],t,e)}function Dr(r,e){var t,a=h0(r.body,e);return r.mclass==="minner"?t=new S.MathNode("mpadded",a):r.mclass==="mord"?r.isCharacterBox?(t=a[0],t.type="mi"):t=new S.MathNode("mi",a):(r.isCharacterBox?(t=a[0],t.type="mo"):t=new S.MathNode("mo",a),r.mclass==="mbin"?(t.attributes.lspace="0.22em",t.attributes.rspace="0.22em"):r.mclass==="mpunct"?(t.attributes.lspace="0em",t.attributes.rspace="0.17em"):r.mclass==="mopen"||r.mclass==="mclose"?(t.attributes.lspace="0em",t.attributes.rspace="0em"):r.mclass==="minner"&&(t.attributes.lspace="0.0556em",t.attributes.width="+0.1111em")),t}B({type:"mclass",names:["\\mathord","\\mathbin","\\mathrel","\\mathopen","\\mathclose","\\mathpunct","\\mathinner"],props:{numArgs:1,primitive:!0},handler(r,e){var{parser:t,funcName:a}=r,i=e[0];return{type:"mclass",mode:t.mode,mclass:"m"+a.slice(5),body:Q(i),isCharacterBox:V.isCharacterBox(i)}},htmlBuilder:Ir,mathmlBuilder:Dr});var Ee=r=>{var e=r.type==="ordgroup"&&r.body.length?r.body[0]:r;return e.type==="atom"&&(e.family==="bin"||e.family==="rel")?"m"+e.family:"mord"};B({type:"mclass",names:["\\@binrel"],props:{numArgs:2},handler(r,e){var{parser:t}=r;return{type:"mclass",mode:t.mode,mclass:Ee(e[0]),body:Q(e[1]),isCharacterBox:V.isCharacterBox(e[1])}}});B({type:"mclass",names:["\\stackrel","\\overset","\\underset"],props:{numArgs:2},handler(r,e){var{parser:t,funcName:a}=r,i=e[1],s=e[0],o;a!=="\\stackrel"?o=Ee(i):o="mrel";var m={type:"op",mode:i.mode,limits:!0,alwaysHandleSupSub:!0,parentIsSupSub:!1,symbol:!1,suppressBaseShift:a!=="\\stackrel",body:Q(i)},c={type:"supsub",mode:s.mode,base:m,sup:a==="\\underset"?null:s,sub:a==="\\underset"?s:null};return{type:"mclass",mode:t.mode,mclass:o,body:[c],isCharacterBox:V.isCharacterBox(c)}},htmlBuilder:Ir,mathmlBuilder:Dr});B({type:"pmb",names:["\\pmb"],props:{numArgs:1,allowedInText:!0},handler(r,e){var{parser:t}=r;return{type:"pmb",mode:t.mode,mclass:Ee(e[0]),body:Q(e[0])}},htmlBuilder(r,e){var t=t0(r.body,e,!0),a=b.makeSpan([r.mclass],t,e);return a.style.textShadow="0.02em 0.01em 0.04px",a},mathmlBuilder(r,e){var t=h0(r.body,e),a=new S.MathNode("mstyle",t);return a.setAttribute("style","text-shadow: 0.02em 0.01em 0.04px"),a}});var B1={">":"\\\\cdrightarrow","<":"\\\\cdleftarrow","=":"\\\\cdlongequal",A:"\\uparrow",V:"\\downarrow","|":"\\Vert",".":"no arrow"},jt=()=>({type:"styling",body:[],mode:"math",style:"display"}),Zt=r=>r.type==="textord"&&r.text==="@",N1=(r,e)=>(r.type==="mathord"||r.type==="atom")&&r.text===e;function C1(r,e,t){var a=B1[r];switch(a){case"\\\\cdrightarrow":case"\\\\cdleftarrow":return t.callFunction(a,[e[0]],[e[1]]);case"\\uparrow":case"\\downarrow":{var i=t.callFunction("\\\\cdleft",[e[0]],[]),s={type:"atom",text:a,mode:"math",family:"rel"},o=t.callFunction("\\Big",[s],[]),m=t.callFunction("\\\\cdright",[e[1]],[]),c={type:"ordgroup",mode:"math",body:[i,o,m]};return t.callFunction("\\\\cdparent",[c],[])}case"\\\\cdlongequal":return t.callFunction("\\\\cdlongequal",[],[]);case"\\Vert":{var p={type:"textord",text:"\\Vert",mode:"math"};return t.callFunction("\\Big",[p],[])}default:return{type:"textord",text:" ",mode:"math"}}}function q1(r){var e=[];for(r.gullet.beginGroup(),r.gullet.macros.set("\\cr","\\\\\\relax"),r.gullet.beginGroup();;){e.push(r.parseExpression(!1,"\\\\")),r.gullet.endGroup(),r.gullet.beginGroup();var t=r.fetch().text;if(t==="&"||t==="\\\\")r.consume();else if(t==="\\end"){e[e.length-1].length===0&&e.pop();break}else throw new M("Expected \\\\ or \\cr or \\end",r.nextToken)}for(var a=[],i=[a],s=0;s<e.length;s++){for(var o=e[s],m=jt(),c=0;c<o.length;c++)if(!Zt(o[c]))m.body.push(o[c]);else{a.push(m),c+=1;var p=wt(o[c]).text,g=new Array(2);if(g[0]={type:"ordgroup",mode:"math",body:[]},g[1]={type:"ordgroup",mode:"math",body:[]},!("=|.".indexOf(p)>-1))if("<>AV".indexOf(p)>-1)for(var y=0;y<2;y++){for(var w=!0,x=c+1;x<o.length;x++){if(N1(o[x],p)){w=!1,c=x;break}if(Zt(o[x]))throw new M("Missing a "+p+" character to complete a CD arrow.",o[x]);g[y].body.push(o[x])}if(w)throw new M("Missing a "+p+" character to complete a CD arrow.",o[c])}else throw new M('Expected one of "<>AV=|." after @',o[c]);var z=C1(p,g,r),A={type:"styling",body:[z],mode:"math",style:"display"};a.push(A),m=jt()}s%2===0?a.push(m):a.shift(),a=[],i.push(a)}r.gullet.endGroup(),r.gullet.endGroup();var C=new Array(i[0].length).fill({type:"align",align:"c",pregap:.25,postgap:.25});return{type:"array",mode:"math",body:i,arraystretch:1,addJot:!0,rowGaps:[null],cols:C,colSeparationType:"CD",hLinesBeforeRow:new Array(i.length+1).fill([])}}B({type:"cdlabel",names:["\\\\cdleft","\\\\cdright"],props:{numArgs:1},handler(r,e){var{parser:t,funcName:a}=r;return{type:"cdlabel",mode:t.mode,side:a.slice(4),label:e[0]}},htmlBuilder(r,e){var t=e.havingStyle(e.style.sup()),a=b.wrapFragment(F(r.label,t,e),e);return a.classes.push("cd-label-"+r.side),a.style.bottom=T(.8-a.depth),a.height=0,a.depth=0,a},mathmlBuilder(r,e){var t=new S.MathNode("mrow",[X(r.label,e)]);return t=new S.MathNode("mpadded",[t]),t.setAttribute("width","0"),r.side==="left"&&t.setAttribute("lspace","-1width"),t.setAttribute("voffset","0.7em"),t=new S.MathNode("mstyle",[t]),t.setAttribute("displaystyle","false"),t.setAttribute("scriptlevel","1"),t}});B({type:"cdlabelparent",names:["\\\\cdparent"],props:{numArgs:1},handler(r,e){var{parser:t}=r;return{type:"cdlabelparent",mode:t.mode,fragment:e[0]}},htmlBuilder(r,e){var t=b.wrapFragment(F(r.fragment,e),e);return t.classes.push("cd-vert-arrow"),t},mathmlBuilder(r,e){return new S.MathNode("mrow",[X(r.fragment,e)])}});B({type:"textord",names:["\\@char"],props:{numArgs:1,allowedInText:!0},handler(r,e){for(var{parser:t}=r,a=H(e[0],"ordgroup"),i=a.body,s="",o=0;o<i.length;o++){var m=H(i[o],"textord");s+=m.text}var c=parseInt(s),p;if(isNaN(c))throw new M("\\@char has non-numeric argument "+s);if(c<0||c>=1114111)throw new M("\\@char with invalid code point "+s);return c<=65535?p=String.fromCharCode(c):(c-=65536,p=String.fromCharCode((c>>10)+55296,(c&1023)+56320)),{type:"textord",mode:t.mode,text:p}}});var Er=(r,e)=>{var t=t0(r.body,e.withColor(r.color),!1);return b.makeFragment(t)},Or=(r,e)=>{var t=h0(r.body,e.withColor(r.color)),a=new S.MathNode("mstyle",t);return a.setAttribute("mathcolor",r.color),a};B({type:"color",names:["\\textcolor"],props:{numArgs:2,allowedInText:!0,argTypes:["color","original"]},handler(r,e){var{parser:t}=r,a=H(e[0],"color-token").color,i=e[1];return{type:"color",mode:t.mode,color:a,body:Q(i)}},htmlBuilder:Er,mathmlBuilder:Or});B({type:"color",names:["\\color"],props:{numArgs:1,allowedInText:!0,argTypes:["color"]},handler(r,e){var{parser:t,breakOnTokenText:a}=r,i=H(e[0],"color-token").color;t.gullet.macros.set("\\current@color",i);var s=t.parseExpression(!0,a);return{type:"color",mode:t.mode,color:i,body:s}},htmlBuilder:Er,mathmlBuilder:Or});B({type:"cr",names:["\\\\"],props:{numArgs:0,numOptionalArgs:0,allowedInText:!0},handler(r,e,t){var{parser:a}=r,i=a.gullet.future().text==="["?a.parseSizeGroup(!0):null,s=!a.settings.displayMode||!a.settings.useStrictBehavior("newLineInDisplayMode","In LaTeX, \\\\ or \\newline does nothing in display mode");return{type:"cr",mode:a.mode,newLine:s,size:i&&H(i,"size").value}},htmlBuilder(r,e){var t=b.makeSpan(["mspace"],[],e);return r.newLine&&(t.classes.push("newline"),r.size&&(t.style.marginTop=T(K(r.size,e)))),t},mathmlBuilder(r,e){var t=new S.MathNode("mspace");return r.newLine&&(t.setAttribute("linebreak","newline"),r.size&&t.setAttribute("height",T(K(r.size,e)))),t}});var mt={"\\global":"\\global","\\long":"\\\\globallong","\\\\globallong":"\\\\globallong","\\def":"\\gdef","\\gdef":"\\gdef","\\edef":"\\xdef","\\xdef":"\\xdef","\\let":"\\\\globallet","\\futurelet":"\\\\globalfuture"},Hr=r=>{var e=r.text;if(/^(?:[\\{}$&#^_]|EOF)$/.test(e))throw new M("Expected a control sequence",r);return e},R1=r=>{var e=r.gullet.popToken();return e.text==="="&&(e=r.gullet.popToken(),e.text===" "&&(e=r.gullet.popToken())),e},Lr=(r,e,t,a)=>{var i=r.gullet.macros.get(t.text);i==null&&(t.noexpand=!0,i={tokens:[t],numArgs:0,unexpandable:!r.gullet.isExpandable(t.text)}),r.gullet.macros.set(e,i,a)};B({type:"internal",names:["\\global","\\long","\\\\globallong"],props:{numArgs:0,allowedInText:!0},handler(r){var{parser:e,funcName:t}=r;e.consumeSpaces();var a=e.fetch();if(mt[a.text])return(t==="\\global"||t==="\\\\globallong")&&(a.text=mt[a.text]),H(e.parseFunction(),"internal");throw new M("Invalid token after macro prefix",a)}});B({type:"internal",names:["\\def","\\gdef","\\edef","\\xdef"],props:{numArgs:0,allowedInText:!0,primitive:!0},handler(r){var{parser:e,funcName:t}=r,a=e.gullet.popToken(),i=a.text;if(/^(?:[\\{}$&#^_]|EOF)$/.test(i))throw new M("Expected a control sequence",a);for(var s=0,o,m=[[]];e.gullet.future().text!=="{";)if(a=e.gullet.popToken(),a.text==="#"){if(e.gullet.future().text==="{"){o=e.gullet.future(),m[s].push("{");break}if(a=e.gullet.popToken(),!/^[1-9]$/.test(a.text))throw new M('Invalid argument number "'+a.text+'"');if(parseInt(a.text)!==s+1)throw new M('Argument number "'+a.text+'" out of order');s++,m.push([])}else{if(a.text==="EOF")throw new M("Expected a macro definition");m[s].push(a.text)}var{tokens:c}=e.gullet.consumeArg();return o&&c.unshift(o),(t==="\\edef"||t==="\\xdef")&&(c=e.gullet.expandTokens(c),c.reverse()),e.gullet.macros.set(i,{tokens:c,numArgs:s,delimiters:m},t===mt[t]),{type:"internal",mode:e.mode}}});B({type:"internal",names:["\\let","\\\\globallet"],props:{numArgs:0,allowedInText:!0,primitive:!0},handler(r){var{parser:e,funcName:t}=r,a=Hr(e.gullet.popToken());e.gullet.consumeSpaces();var i=R1(e);return Lr(e,a,i,t==="\\\\globallet"),{type:"internal",mode:e.mode}}});B({type:"internal",names:["\\futurelet","\\\\globalfuture"],props:{numArgs:0,allowedInText:!0,primitive:!0},handler(r){var{parser:e,funcName:t}=r,a=Hr(e.gullet.popToken()),i=e.gullet.popToken(),s=e.gullet.popToken();return Lr(e,a,s,t==="\\\\globalfuture"),e.gullet.pushToken(s),e.gullet.pushToken(i),{type:"internal",mode:e.mode}}});var ne=function(e,t,a){var i=$.math[e]&&$.math[e].replace,s=pt(i||e,t,a);if(!s)throw new Error("Unsupported symbol "+e+" and font size "+t+".");return s},kt=function(e,t,a,i){var s=a.havingBaseStyle(t),o=b.makeSpan(i.concat(s.sizingClasses(a)),[e],a),m=s.sizeMultiplier/a.sizeMultiplier;return o.height*=m,o.depth*=m,o.maxFontSize=s.sizeMultiplier,o},Fr=function(e,t,a){var i=t.havingBaseStyle(a),s=(1-t.sizeMultiplier/i.sizeMultiplier)*t.fontMetrics().axisHeight;e.classes.push("delimcenter"),e.style.top=T(s),e.height-=s,e.depth+=s},I1=function(e,t,a,i,s,o){var m=b.makeSymbol(e,"Main-Regular",s,i),c=kt(m,t,i,o);return a&&Fr(c,i,t),c},D1=function(e,t,a,i){return b.makeSymbol(e,"Size"+t+"-Regular",a,i)},Pr=function(e,t,a,i,s,o){var m=D1(e,t,s,i),c=kt(b.makeSpan(["delimsizing","size"+t],[m],i),I.TEXT,i,o);return a&&Fr(c,i,I.TEXT),c},Ze=function(e,t,a){var i;t==="Size1-Regular"?i="delim-size1":i="delim-size4";var s=b.makeSpan(["delimsizinginner",i],[b.makeSpan([],[b.makeSymbol(e,t,a)])]);return{type:"elem",elem:s}},Ke=function(e,t,a){var i=w0["Size4-Regular"][e.charCodeAt(0)]?w0["Size4-Regular"][e.charCodeAt(0)][4]:w0["Size1-Regular"][e.charCodeAt(0)][4],s=new V0("inner",Fa(e,Math.round(1e3*t))),o=new C0([s],{width:T(i),height:T(t),style:"width:"+T(i),viewBox:"0 0 "+1e3*i+" "+Math.round(1e3*t),preserveAspectRatio:"xMinYMin"}),m=b.makeSvgSpan([],[o],a);return m.height=t,m.style.height=T(t),m.style.width=T(i),{type:"elem",elem:m}},ut=.008,Se={type:"kern",size:-1*ut},E1=["|","\\lvert","\\rvert","\\vert"],O1=["\\|","\\lVert","\\rVert","\\Vert"],Vr=function(e,t,a,i,s,o){var m,c,p,g,y="",w=0;m=p=g=e,c=null;var x="Size1-Regular";e==="\\uparrow"?p=g="⏐":e==="\\Uparrow"?p=g="‖":e==="\\downarrow"?m=p="⏐":e==="\\Downarrow"?m=p="‖":e==="\\updownarrow"?(m="\\uparrow",p="⏐",g="\\downarrow"):e==="\\Updownarrow"?(m="\\Uparrow",p="‖",g="\\Downarrow"):E1.includes(e)?(p="∣",y="vert",w=333):O1.includes(e)?(p="∥",y="doublevert",w=556):e==="["||e==="\\lbrack"?(m="⎡",p="⎢",g="⎣",x="Size4-Regular",y="lbrack",w=667):e==="]"||e==="\\rbrack"?(m="⎤",p="⎥",g="⎦",x="Size4-Regular",y="rbrack",w=667):e==="\\lfloor"||e==="⌊"?(p=m="⎢",g="⎣",x="Size4-Regular",y="lfloor",w=667):e==="\\lceil"||e==="⌈"?(m="⎡",p=g="⎢",x="Size4-Regular",y="lceil",w=667):e==="\\rfloor"||e==="⌋"?(p=m="⎥",g="⎦",x="Size4-Regular",y="rfloor",w=667):e==="\\rceil"||e==="⌉"?(m="⎤",p=g="⎥",x="Size4-Regular",y="rceil",w=667):e==="("||e==="\\lparen"?(m="⎛",p="⎜",g="⎝",x="Size4-Regular",y="lparen",w=875):e===")"||e==="\\rparen"?(m="⎞",p="⎟",g="⎠",x="Size4-Regular",y="rparen",w=875):e==="\\{"||e==="\\lbrace"?(m="⎧",c="⎨",g="⎩",p="⎪",x="Size4-Regular"):e==="\\}"||e==="\\rbrace"?(m="⎫",c="⎬",g="⎭",p="⎪",x="Size4-Regular"):e==="\\lgroup"||e==="⟮"?(m="⎧",g="⎩",p="⎪",x="Size4-Regular"):e==="\\rgroup"||e==="⟯"?(m="⎫",g="⎭",p="⎪",x="Size4-Regular"):e==="\\lmoustache"||e==="⎰"?(m="⎧",g="⎭",p="⎪",x="Size4-Regular"):(e==="\\rmoustache"||e==="⎱")&&(m="⎫",g="⎩",p="⎪",x="Size4-Regular");var z=ne(m,x,s),A=z.height+z.depth,C=ne(p,x,s),q=C.height+C.depth,E=ne(g,x,s),O=E.height+E.depth,G=0,L=1;if(c!==null){var U=ne(c,x,s);G=U.height+U.depth,L=2}var P=A+O+G,j=Math.max(0,Math.ceil((t-P)/(L*q))),Y=P+j*L*q,z0=i.fontMetrics().axisHeight;a&&(z0*=i.sizeMultiplier);var r0=Y/2-z0,e0=[];if(y.length>0){var Y0=Y-A-O,s0=Math.round(Y*1e3),g0=Pa(y,Math.round(Y0*1e3)),D0=new V0(y,g0),j0=(w/1e3).toFixed(3)+"em",Z0=(s0/1e3).toFixed(3)+"em",Fe=new C0([D0],{width:j0,height:Z0,viewBox:"0 0 "+w+" "+s0}),E0=b.makeSvgSpan([],[Fe],i);E0.height=s0/1e3,E0.style.width=j0,E0.style.height=Z0,e0.push({type:"elem",elem:E0})}else{if(e0.push(Ze(g,x,s)),e0.push(Se),c===null){var O0=Y-A-O+2*ut;e0.push(Ke(p,O0,i))}else{var d0=(Y-A-O-G)/2+2*ut;e0.push(Ke(p,d0,i)),e0.push(Se),e0.push(Ze(c,x,s)),e0.push(Se),e0.push(Ke(p,d0,i))}e0.push(Se),e0.push(Ze(m,x,s))}var ie=i.havingBaseStyle(I.TEXT),Pe=b.makeVList({positionType:"bottom",positionData:r0,children:e0},ie);return kt(b.makeSpan(["delimsizing","mult"],[Pe],ie),I.TEXT,i,o)},Je=80,Qe=.08,_e=function(e,t,a,i,s){var o=La(e,i,a),m=new V0(e,o),c=new C0([m],{width:"400em",height:T(t),viewBox:"0 0 400000 "+a,preserveAspectRatio:"xMinYMin slice"});return b.makeSvgSpan(["hide-tail"],[c],s)},H1=function(e,t){var a=t.havingBaseSizing(),i=Xr("\\surd",e*a.sizeMultiplier,Yr,a),s=a.sizeMultiplier,o=Math.max(0,t.minRuleThickness-t.fontMetrics().sqrtRuleThickness),m,c=0,p=0,g=0,y;return i.type==="small"?(g=1e3+1e3*o+Je,e<1?s=1:e<1.4&&(s=.7),c=(1+o+Qe)/s,p=(1+o)/s,m=_e("sqrtMain",c,g,o,t),m.style.minWidth="0.853em",y=.833/s):i.type==="large"?(g=(1e3+Je)*se[i.size],p=(se[i.size]+o)/s,c=(se[i.size]+o+Qe)/s,m=_e("sqrtSize"+i.size,c,g,o,t),m.style.minWidth="1.02em",y=1/s):(c=e+o+Qe,p=e+o,g=Math.floor(1e3*e+o)+Je,m=_e("sqrtTall",c,g,o,t),m.style.minWidth="0.742em",y=1.056),m.height=p,m.style.height=T(c),{span:m,advanceWidth:y,ruleWidth:(t.fontMetrics().sqrtRuleThickness+o)*s}},Gr=["(","\\lparen",")","\\rparen","[","\\lbrack","]","\\rbrack","\\{","\\lbrace","\\}","\\rbrace","\\lfloor","\\rfloor","⌊","⌋","\\lceil","\\rceil","⌈","⌉","\\surd"],L1=["\\uparrow","\\downarrow","\\updownarrow","\\Uparrow","\\Downarrow","\\Updownarrow","|","\\|","\\vert","\\Vert","\\lvert","\\rvert","\\lVert","\\rVert","\\lgroup","\\rgroup","⟮","⟯","\\lmoustache","\\rmoustache","⎰","⎱"],Ur=["<",">","\\langle","\\rangle","/","\\backslash","\\lt","\\gt"],se=[0,1.2,1.8,2.4,3],F1=function(e,t,a,i,s){if(e==="<"||e==="\\lt"||e==="⟨"?e="\\langle":(e===">"||e==="\\gt"||e==="⟩")&&(e="\\rangle"),Gr.includes(e)||Ur.includes(e))return Pr(e,t,!1,a,i,s);if(L1.includes(e))return Vr(e,se[t],!1,a,i,s);throw new M("Illegal delimiter: '"+e+"'")},P1=[{type:"small",style:I.SCRIPTSCRIPT},{type:"small",style:I.SCRIPT},{type:"small",style:I.TEXT},{type:"large",size:1},{type:"large",size:2},{type:"large",size:3},{type:"large",size:4}],V1=[{type:"small",style:I.SCRIPTSCRIPT},{type:"small",style:I.SCRIPT},{type:"small",style:I.TEXT},{type:"stack"}],Yr=[{type:"small",style:I.SCRIPTSCRIPT},{type:"small",style:I.SCRIPT},{type:"small",style:I.TEXT},{type:"large",size:1},{type:"large",size:2},{type:"large",size:3},{type:"large",size:4},{type:"stack"}],G1=function(e){if(e.type==="small")return"Main-Regular";if(e.type==="large")return"Size"+e.size+"-Regular";if(e.type==="stack")return"Size4-Regular";throw new Error("Add support for delim type '"+e.type+"' here.")},Xr=function(e,t,a,i){for(var s=Math.min(2,3-i.style.size),o=s;o<a.length&&a[o].type!=="stack";o++){var m=ne(e,G1(a[o]),"math"),c=m.height+m.depth;if(a[o].type==="small"){var p=i.havingBaseStyle(a[o].style);c*=p.sizeMultiplier}if(c>t)return a[o]}return a[a.length-1]},$r=function(e,t,a,i,s,o){e==="<"||e==="\\lt"||e==="⟨"?e="\\langle":(e===">"||e==="\\gt"||e==="⟩")&&(e="\\rangle");var m;Ur.includes(e)?m=P1:Gr.includes(e)?m=Yr:m=V1;var c=Xr(e,t,m,i);return c.type==="small"?I1(e,c.style,a,i,s,o):c.type==="large"?Pr(e,c.size,a,i,s,o):Vr(e,t,a,i,s,o)},U1=function(e,t,a,i,s,o){var m=i.fontMetrics().axisHeight*i.sizeMultiplier,c=901,p=5/i.fontMetrics().ptPerEm,g=Math.max(t-m,a+m),y=Math.max(g/500*c,2*g-p);return $r(e,y,!0,i,s,o)},N0={sqrtImage:H1,sizedDelim:F1,sizeToMaxHeight:se,customSizedDelim:$r,leftRightDelim:U1},Kt={"\\bigl":{mclass:"mopen",size:1},"\\Bigl":{mclass:"mopen",size:2},"\\biggl":{mclass:"mopen",size:3},"\\Biggl":{mclass:"mopen",size:4},"\\bigr":{mclass:"mclose",size:1},"\\Bigr":{mclass:"mclose",size:2},"\\biggr":{mclass:"mclose",size:3},"\\Biggr":{mclass:"mclose",size:4},"\\bigm":{mclass:"mrel",size:1},"\\Bigm":{mclass:"mrel",size:2},"\\biggm":{mclass:"mrel",size:3},"\\Biggm":{mclass:"mrel",size:4},"\\big":{mclass:"mord",size:1},"\\Big":{mclass:"mord",size:2},"\\bigg":{mclass:"mord",size:3},"\\Bigg":{mclass:"mord",size:4}},Y1=["(","\\lparen",")","\\rparen","[","\\lbrack","]","\\rbrack","\\{","\\lbrace","\\}","\\rbrace","\\lfloor","\\rfloor","⌊","⌋","\\lceil","\\rceil","⌈","⌉","<",">","\\langle","⟨","\\rangle","⟩","\\lt","\\gt","\\lvert","\\rvert","\\lVert","\\rVert","\\lgroup","\\rgroup","⟮","⟯","\\lmoustache","\\rmoustache","⎰","⎱","/","\\backslash","|","\\vert","\\|","\\Vert","\\uparrow","\\Uparrow","\\downarrow","\\Downarrow","\\updownarrow","\\Updownarrow","."];function Oe(r,e){var t=De(r);if(t&&Y1.includes(t.text))return t;throw t?new M("Invalid delimiter '"+t.text+"' after '"+e.funcName+"'",r):new M("Invalid delimiter type '"+r.type+"'",r)}B({type:"delimsizing",names:["\\bigl","\\Bigl","\\biggl","\\Biggl","\\bigr","\\Bigr","\\biggr","\\Biggr","\\bigm","\\Bigm","\\biggm","\\Biggm","\\big","\\Big","\\bigg","\\Bigg"],props:{numArgs:1,argTypes:["primitive"]},handler:(r,e)=>{var t=Oe(e[0],r);return{type:"delimsizing",mode:r.parser.mode,size:Kt[r.funcName].size,mclass:Kt[r.funcName].mclass,delim:t.text}},htmlBuilder:(r,e)=>r.delim==="."?b.makeSpan([r.mclass]):N0.sizedDelim(r.delim,r.size,e,r.mode,[r.mclass]),mathmlBuilder:r=>{var e=[];r.delim!=="."&&e.push(v0(r.delim,r.mode));var t=new S.MathNode("mo",e);r.mclass==="mopen"||r.mclass==="mclose"?t.setAttribute("fence","true"):t.setAttribute("fence","false"),t.setAttribute("stretchy","true");var a=T(N0.sizeToMaxHeight[r.size]);return t.setAttribute("minsize",a),t.setAttribute("maxsize",a),t}});function Jt(r){if(!r.body)throw new Error("Bug: The leftright ParseNode wasn't fully parsed.")}B({type:"leftright-right",names:["\\right"],props:{numArgs:1,primitive:!0},handler:(r,e)=>{var t=r.parser.gullet.macros.get("\\current@color");if(t&&typeof t!="string")throw new M("\\current@color set to non-string in \\right");return{type:"leftright-right",mode:r.parser.mode,delim:Oe(e[0],r).text,color:t}}});B({type:"leftright",names:["\\left"],props:{numArgs:1,primitive:!0},handler:(r,e)=>{var t=Oe(e[0],r),a=r.parser;++a.leftrightDepth;var i=a.parseExpression(!1);--a.leftrightDepth,a.expect("\\right",!1);var s=H(a.parseFunction(),"leftright-right");return{type:"leftright",mode:a.mode,body:i,left:t.text,right:s.delim,rightColor:s.color}},htmlBuilder:(r,e)=>{Jt(r);for(var t=t0(r.body,e,!0,["mopen","mclose"]),a=0,i=0,s=!1,o=0;o<t.length;o++)t[o].isMiddle?s=!0:(a=Math.max(t[o].height,a),i=Math.max(t[o].depth,i));a*=e.sizeMultiplier,i*=e.sizeMultiplier;var m;if(r.left==="."?m=oe(e,["mopen"]):m=N0.leftRightDelim(r.left,a,i,e,r.mode,["mopen"]),t.unshift(m),s)for(var c=1;c<t.length;c++){var p=t[c],g=p.isMiddle;g&&(t[c]=N0.leftRightDelim(g.delim,a,i,g.options,r.mode,[]))}var y;if(r.right===".")y=oe(e,["mclose"]);else{var w=r.rightColor?e.withColor(r.rightColor):e;y=N0.leftRightDelim(r.right,a,i,w,r.mode,["mclose"])}return t.push(y),b.makeSpan(["minner"],t,e)},mathmlBuilder:(r,e)=>{Jt(r);var t=h0(r.body,e);if(r.left!=="."){var a=new S.MathNode("mo",[v0(r.left,r.mode)]);a.setAttribute("fence","true"),t.unshift(a)}if(r.right!=="."){var i=new S.MathNode("mo",[v0(r.right,r.mode)]);i.setAttribute("fence","true"),r.rightColor&&i.setAttribute("mathcolor",r.rightColor),t.push(i)}return bt(t)}});B({type:"middle",names:["\\middle"],props:{numArgs:1,primitive:!0},handler:(r,e)=>{var t=Oe(e[0],r);if(!r.parser.leftrightDepth)throw new M("\\middle without preceding \\left",t);return{type:"middle",mode:r.parser.mode,delim:t.text}},htmlBuilder:(r,e)=>{var t;if(r.delim===".")t=oe(e,[]);else{t=N0.sizedDelim(r.delim,1,e,r.mode,[]);var a={delim:r.delim,options:e};t.isMiddle=a}return t},mathmlBuilder:(r,e)=>{var t=r.delim==="\\vert"||r.delim==="|"?v0("|","text"):v0(r.delim,r.mode),a=new S.MathNode("mo",[t]);return a.setAttribute("fence","true"),a.setAttribute("lspace","0.05em"),a.setAttribute("rspace","0.05em"),a}});var St=(r,e)=>{var t=b.wrapFragment(F(r.body,e),e),a=r.label.slice(1),i=e.sizeMultiplier,s,o=0,m=V.isCharacterBox(r.body);if(a==="sout")s=b.makeSpan(["stretchy","sout"]),s.height=e.fontMetrics().defaultRuleThickness/i,o=-.5*e.fontMetrics().xHeight;else if(a==="phase"){var c=K({number:.6,unit:"pt"},e),p=K({number:.35,unit:"ex"},e),g=e.havingBaseSizing();i=i/g.sizeMultiplier;var y=t.height+t.depth+c+p;t.style.paddingLeft=T(y/2+c);var w=Math.floor(1e3*y*i),x=Oa(w),z=new C0([new V0("phase",x)],{width:"400em",height:T(w/1e3),viewBox:"0 0 400000 "+w,preserveAspectRatio:"xMinYMin slice"});s=b.makeSvgSpan(["hide-tail"],[z],e),s.style.height=T(y),o=t.depth+c+p}else{/cancel/.test(a)?m||t.classes.push("cancel-pad"):a==="angl"?t.classes.push("anglpad"):t.classes.push("boxpad");var A=0,C=0,q=0;/box/.test(a)?(q=Math.max(e.fontMetrics().fboxrule,e.minRuleThickness),A=e.fontMetrics().fboxsep+(a==="colorbox"?0:q),C=A):a==="angl"?(q=Math.max(e.fontMetrics().defaultRuleThickness,e.minRuleThickness),A=4*q,C=Math.max(0,.25-t.depth)):(A=m?.2:0,C=A),s=R0.encloseSpan(t,a,A,C,e),/fbox|boxed|fcolorbox/.test(a)?(s.style.borderStyle="solid",s.style.borderWidth=T(q)):a==="angl"&&q!==.049&&(s.style.borderTopWidth=T(q),s.style.borderRightWidth=T(q)),o=t.depth+C,r.backgroundColor&&(s.style.backgroundColor=r.backgroundColor,r.borderColor&&(s.style.borderColor=r.borderColor))}var E;if(r.backgroundColor)E=b.makeVList({positionType:"individualShift",children:[{type:"elem",elem:s,shift:o},{type:"elem",elem:t,shift:0}]},e);else{var O=/cancel|phase/.test(a)?["svg-align"]:[];E=b.makeVList({positionType:"individualShift",children:[{type:"elem",elem:t,shift:0},{type:"elem",elem:s,shift:o,wrapperClasses:O}]},e)}return/cancel/.test(a)&&(E.height=t.height,E.depth=t.depth),/cancel/.test(a)&&!m?b.makeSpan(["mord","cancel-lap"],[E],e):b.makeSpan(["mord"],[E],e)},Mt=(r,e)=>{var t=0,a=new S.MathNode(r.label.indexOf("colorbox")>-1?"mpadded":"menclose",[X(r.body,e)]);switch(r.label){case"\\cancel":a.setAttribute("notation","updiagonalstrike");break;case"\\bcancel":a.setAttribute("notation","downdiagonalstrike");break;case"\\phase":a.setAttribute("notation","phasorangle");break;case"\\sout":a.setAttribute("notation","horizontalstrike");break;case"\\fbox":a.setAttribute("notation","box");break;case"\\angl":a.setAttribute("notation","actuarial");break;case"\\fcolorbox":case"\\colorbox":if(t=e.fontMetrics().fboxsep*e.fontMetrics().ptPerEm,a.setAttribute("width","+"+2*t+"pt"),a.setAttribute("height","+"+2*t+"pt"),a.setAttribute("lspace",t+"pt"),a.setAttribute("voffset",t+"pt"),r.label==="\\fcolorbox"){var i=Math.max(e.fontMetrics().fboxrule,e.minRuleThickness);a.setAttribute("style","border: "+i+"em solid "+String(r.borderColor))}break;case"\\xcancel":a.setAttribute("notation","updiagonalstrike downdiagonalstrike");break}return r.backgroundColor&&a.setAttribute("mathbackground",r.backgroundColor),a};B({type:"enclose",names:["\\colorbox"],props:{numArgs:2,allowedInText:!0,argTypes:["color","text"]},handler(r,e,t){var{parser:a,funcName:i}=r,s=H(e[0],"color-token").color,o=e[1];return{type:"enclose",mode:a.mode,label:i,backgroundColor:s,body:o}},htmlBuilder:St,mathmlBuilder:Mt});B({type:"enclose",names:["\\fcolorbox"],props:{numArgs:3,allowedInText:!0,argTypes:["color","color","text"]},handler(r,e,t){var{parser:a,funcName:i}=r,s=H(e[0],"color-token").color,o=H(e[1],"color-token").color,m=e[2];return{type:"enclose",mode:a.mode,label:i,backgroundColor:o,borderColor:s,body:m}},htmlBuilder:St,mathmlBuilder:Mt});B({type:"enclose",names:["\\fbox"],props:{numArgs:1,argTypes:["hbox"],allowedInText:!0},handler(r,e){var{parser:t}=r;return{type:"enclose",mode:t.mode,label:"\\fbox",body:e[0]}}});B({type:"enclose",names:["\\cancel","\\bcancel","\\xcancel","\\sout","\\phase"],props:{numArgs:1},handler(r,e){var{parser:t,funcName:a}=r,i=e[0];return{type:"enclose",mode:t.mode,label:a,body:i}},htmlBuilder:St,mathmlBuilder:Mt});B({type:"enclose",names:["\\angl"],props:{numArgs:1,argTypes:["hbox"],allowedInText:!1},handler(r,e){var{parser:t}=r;return{type:"enclose",mode:t.mode,label:"\\angl",body:e[0]}}});var Wr={};function k0(r){for(var{type:e,names:t,props:a,handler:i,htmlBuilder:s,mathmlBuilder:o}=r,m={type:e,numArgs:a.numArgs||0,allowedInText:!1,numOptionalArgs:0,handler:i},c=0;c<t.length;++c)Wr[t[c]]=m;s&&(Ne[e]=s),o&&(Ce[e]=o)}var jr={};function u(r,e){jr[r]=e}function Qt(r){var e=[];r.consumeSpaces();var t=r.fetch().text;for(t==="\\relax"&&(r.consume(),r.consumeSpaces(),t=r.fetch().text);t==="\\hline"||t==="\\hdashline";)r.consume(),e.push(t==="\\hdashline"),r.consumeSpaces(),t=r.fetch().text;return e}var He=r=>{var e=r.parser.settings;if(!e.displayMode)throw new M("{"+r.envName+"} can be used only in display mode.")};function zt(r){if(r.indexOf("ed")===-1)return r.indexOf("*")===-1}function U0(r,e,t){var{hskipBeforeAndAfter:a,addJot:i,cols:s,arraystretch:o,colSeparationType:m,autoTag:c,singleRow:p,emptySingleRow:g,maxNumCols:y,leqno:w}=e;if(r.gullet.beginGroup(),p||r.gullet.macros.set("\\cr","\\\\\\relax"),!o){var x=r.gullet.expandMacroAsText("\\arraystretch");if(x==null)o=1;else if(o=parseFloat(x),!o||o<0)throw new M("Invalid \\arraystretch: "+x)}r.gullet.beginGroup();var z=[],A=[z],C=[],q=[],E=c!=null?[]:void 0;function O(){c&&r.gullet.macros.set("\\@eqnsw","1",!0)}function G(){E&&(r.gullet.macros.get("\\df@tag")?(E.push(r.subparse([new u0("\\df@tag")])),r.gullet.macros.set("\\df@tag",void 0,!0)):E.push(!!c&&r.gullet.macros.get("\\@eqnsw")==="1"))}for(O(),q.push(Qt(r));;){var L=r.parseExpression(!1,p?"\\end":"\\\\");r.gullet.endGroup(),r.gullet.beginGroup(),L={type:"ordgroup",mode:r.mode,body:L},t&&(L={type:"styling",mode:r.mode,style:t,body:[L]}),z.push(L);var U=r.fetch().text;if(U==="&"){if(y&&z.length===y){if(p||m)throw new M("Too many tab characters: &",r.nextToken);r.settings.reportNonstrict("textEnv","Too few columns specified in the {array} column argument.")}r.consume()}else if(U==="\\end"){G(),z.length===1&&L.type==="styling"&&L.body[0].body.length===0&&(A.length>1||!g)&&A.pop(),q.length<A.length+1&&q.push([]);break}else if(U==="\\\\"){r.consume();var P=void 0;r.gullet.future().text!==" "&&(P=r.parseSizeGroup(!0)),C.push(P?P.value:null),G(),q.push(Qt(r)),z=[],A.push(z),O()}else throw new M("Expected & or \\\\ or \\cr or \\end",r.nextToken)}return r.gullet.endGroup(),r.gullet.endGroup(),{type:"array",mode:r.mode,addJot:i,arraystretch:o,body:A,cols:s,rowGaps:C,hskipBeforeAndAfter:a,hLinesBeforeRow:q,colSeparationType:m,tags:E,leqno:w}}function Tt(r){return r.slice(0,1)==="d"?"display":"text"}var S0=function(e,t){var a,i,s=e.body.length,o=e.hLinesBeforeRow,m=0,c=new Array(s),p=[],g=Math.max(t.fontMetrics().arrayRuleWidth,t.minRuleThickness),y=1/t.fontMetrics().ptPerEm,w=5*y;if(e.colSeparationType&&e.colSeparationType==="small"){var x=t.havingStyle(I.SCRIPT).sizeMultiplier;w=.2778*(x/t.sizeMultiplier)}var z=e.colSeparationType==="CD"?K({number:3,unit:"ex"},t):12*y,A=3*y,C=e.arraystretch*z,q=.7*C,E=.3*C,O=0;function G(fe){for(var pe=0;pe<fe.length;++pe)pe>0&&(O+=.25),p.push({pos:O,isDashed:fe[pe]})}for(G(o[0]),a=0;a<e.body.length;++a){var L=e.body[a],U=q,P=E;m<L.length&&(m=L.length);var j=new Array(L.length);for(i=0;i<L.length;++i){var Y=F(L[i],t);P<Y.depth&&(P=Y.depth),U<Y.height&&(U=Y.height),j[i]=Y}var z0=e.rowGaps[a],r0=0;z0&&(r0=K(z0,t),r0>0&&(r0+=E,P<r0&&(P=r0),r0=0)),e.addJot&&(P+=A),j.height=U,j.depth=P,O+=U,j.pos=O,O+=P+r0,c[a]=j,G(o[a+1])}var e0=O/2+t.fontMetrics().axisHeight,Y0=e.cols||[],s0=[],g0,D0,j0=[];if(e.tags&&e.tags.some(fe=>fe))for(a=0;a<s;++a){var Z0=c[a],Fe=Z0.pos-e0,E0=e.tags[a],O0=void 0;E0===!0?O0=b.makeSpan(["eqn-num"],[],t):E0===!1?O0=b.makeSpan([],[],t):O0=b.makeSpan([],t0(E0,t,!0),t),O0.depth=Z0.depth,O0.height=Z0.height,j0.push({type:"elem",elem:O0,shift:Fe})}for(i=0,D0=0;i<m||D0<Y0.length;++i,++D0){for(var d0=Y0[D0]||{},ie=!0;d0.type==="separator";){if(ie||(g0=b.makeSpan(["arraycolsep"],[]),g0.style.width=T(t.fontMetrics().doubleRuleSep),s0.push(g0)),d0.separator==="|"||d0.separator===":"){var Pe=d0.separator==="|"?"solid":"dashed",K0=b.makeSpan(["vertical-separator"],[],t);K0.style.height=T(O),K0.style.borderRightWidth=T(g),K0.style.borderRightStyle=Pe,K0.style.margin="0 "+T(-g/2);var It=O-e0;It&&(K0.style.verticalAlign=T(-It)),s0.push(K0)}else throw new M("Invalid separator type: "+d0.separator);D0++,d0=Y0[D0]||{},ie=!1}if(!(i>=m)){var J0=void 0;(i>0||e.hskipBeforeAndAfter)&&(J0=V.deflt(d0.pregap,w),J0!==0&&(g0=b.makeSpan(["arraycolsep"],[]),g0.style.width=T(J0),s0.push(g0)));var Q0=[];for(a=0;a<s;++a){var ce=c[a],de=ce[i];if(de){var ua=ce.pos-e0;de.depth=ce.depth,de.height=ce.height,Q0.push({type:"elem",elem:de,shift:ua})}}Q0=b.makeVList({positionType:"individualShift",children:Q0},t),Q0=b.makeSpan(["col-align-"+(d0.align||"c")],[Q0]),s0.push(Q0),(i<m-1||e.hskipBeforeAndAfter)&&(J0=V.deflt(d0.postgap,w),J0!==0&&(g0=b.makeSpan(["arraycolsep"],[]),g0.style.width=T(J0),s0.push(g0)))}}if(c=b.makeSpan(["mtable"],s0),p.length>0){for(var ca=b.makeLineSpan("hline",t,g),da=b.makeLineSpan("hdashline",t,g),Ve=[{type:"elem",elem:c,shift:0}];p.length>0;){var Dt=p.pop(),Et=Dt.pos-e0;Dt.isDashed?Ve.push({type:"elem",elem:da,shift:Et}):Ve.push({type:"elem",elem:ca,shift:Et})}c=b.makeVList({positionType:"individualShift",children:Ve},t)}if(j0.length===0)return b.makeSpan(["mord"],[c],t);var Ge=b.makeVList({positionType:"individualShift",children:j0},t);return Ge=b.makeSpan(["tag"],[Ge],t),b.makeFragment([c,Ge])},X1={c:"center ",l:"left ",r:"right "},M0=function(e,t){for(var a=[],i=new S.MathNode("mtd",[],["mtr-glue"]),s=new S.MathNode("mtd",[],["mml-eqn-num"]),o=0;o<e.body.length;o++){for(var m=e.body[o],c=[],p=0;p<m.length;p++)c.push(new S.MathNode("mtd",[X(m[p],t)]));e.tags&&e.tags[o]&&(c.unshift(i),c.push(i),e.leqno?c.unshift(s):c.push(s)),a.push(new S.MathNode("mtr",c))}var g=new S.MathNode("mtable",a),y=e.arraystretch===.5?.1:.16+e.arraystretch-1+(e.addJot?.09:0);g.setAttribute("rowspacing",T(y));var w="",x="";if(e.cols&&e.cols.length>0){var z=e.cols,A="",C=!1,q=0,E=z.length;z[0].type==="separator"&&(w+="top ",q=1),z[z.length-1].type==="separator"&&(w+="bottom ",E-=1);for(var O=q;O<E;O++)z[O].type==="align"?(x+=X1[z[O].align],C&&(A+="none "),C=!0):z[O].type==="separator"&&C&&(A+=z[O].separator==="|"?"solid ":"dashed ",C=!1);g.setAttribute("columnalign",x.trim()),/[sd]/.test(A)&&g.setAttribute("columnlines",A.trim())}if(e.colSeparationType==="align"){for(var G=e.cols||[],L="",U=1;U<G.length;U++)L+=U%2?"0em ":"1em ";g.setAttribute("columnspacing",L.trim())}else e.colSeparationType==="alignat"||e.colSeparationType==="gather"?g.setAttribute("columnspacing","0em"):e.colSeparationType==="small"?g.setAttribute("columnspacing","0.2778em"):e.colSeparationType==="CD"?g.setAttribute("columnspacing","0.5em"):g.setAttribute("columnspacing","1em");var P="",j=e.hLinesBeforeRow;w+=j[0].length>0?"left ":"",w+=j[j.length-1].length>0?"right ":"";for(var Y=1;Y<j.length-1;Y++)P+=j[Y].length===0?"none ":j[Y][0]?"dashed ":"solid ";return/[sd]/.test(P)&&g.setAttribute("rowlines",P.trim()),w!==""&&(g=new S.MathNode("menclose",[g]),g.setAttribute("notation",w.trim())),e.arraystretch&&e.arraystretch<1&&(g=new S.MathNode("mstyle",[g]),g.setAttribute("scriptlevel","1")),g},Zr=function(e,t){e.envName.indexOf("ed")===-1&&He(e);var a=[],i=e.envName.indexOf("at")>-1?"alignat":"align",s=e.envName==="split",o=U0(e.parser,{cols:a,addJot:!0,autoTag:s?void 0:zt(e.envName),emptySingleRow:!0,colSeparationType:i,maxNumCols:s?2:void 0,leqno:e.parser.settings.leqno},"display"),m,c=0,p={type:"ordgroup",mode:e.mode,body:[]};if(t[0]&&t[0].type==="ordgroup"){for(var g="",y=0;y<t[0].body.length;y++){var w=H(t[0].body[y],"textord");g+=w.text}m=Number(g),c=m*2}var x=!c;o.body.forEach(function(q){for(var E=1;E<q.length;E+=2){var O=H(q[E],"styling"),G=H(O.body[0],"ordgroup");G.body.unshift(p)}if(x)c<q.length&&(c=q.length);else{var L=q.length/2;if(m<L)throw new M("Too many math in a row: "+("expected "+m+", but got "+L),q[0])}});for(var z=0;z<c;++z){var A="r",C=0;z%2===1?A="l":z>0&&x&&(C=1),a[z]={type:"align",align:A,pregap:C,postgap:0}}return o.colSeparationType=x?"align":"alignat",o};k0({type:"array",names:["array","darray"],props:{numArgs:1},handler(r,e){var t=De(e[0]),a=t?[e[0]]:H(e[0],"ordgroup").body,i=a.map(function(o){var m=wt(o),c=m.text;if("lcr".indexOf(c)!==-1)return{type:"align",align:c};if(c==="|")return{type:"separator",separator:"|"};if(c===":")return{type:"separator",separator:":"};throw new M("Unknown column alignment: "+c,o)}),s={cols:i,hskipBeforeAndAfter:!0,maxNumCols:i.length};return U0(r.parser,s,Tt(r.envName))},htmlBuilder:S0,mathmlBuilder:M0});k0({type:"array",names:["matrix","pmatrix","bmatrix","Bmatrix","vmatrix","Vmatrix","matrix*","pmatrix*","bmatrix*","Bmatrix*","vmatrix*","Vmatrix*"],props:{numArgs:0},handler(r){var e={matrix:null,pmatrix:["(",")"],bmatrix:["[","]"],Bmatrix:["\\{","\\}"],vmatrix:["|","|"],Vmatrix:["\\Vert","\\Vert"]}[r.envName.replace("*","")],t="c",a={hskipBeforeAndAfter:!1,cols:[{type:"align",align:t}]};if(r.envName.charAt(r.envName.length-1)==="*"){var i=r.parser;if(i.consumeSpaces(),i.fetch().text==="["){if(i.consume(),i.consumeSpaces(),t=i.fetch().text,"lcr".indexOf(t)===-1)throw new M("Expected l or c or r",i.nextToken);i.consume(),i.consumeSpaces(),i.expect("]"),i.consume(),a.cols=[{type:"align",align:t}]}}var s=U0(r.parser,a,Tt(r.envName)),o=Math.max(0,...s.body.map(m=>m.length));return s.cols=new Array(o).fill({type:"align",align:t}),e?{type:"leftright",mode:r.mode,body:[s],left:e[0],right:e[1],rightColor:void 0}:s},htmlBuilder:S0,mathmlBuilder:M0});k0({type:"array",names:["smallmatrix"],props:{numArgs:0},handler(r){var e={arraystretch:.5},t=U0(r.parser,e,"script");return t.colSeparationType="small",t},htmlBuilder:S0,mathmlBuilder:M0});k0({type:"array",names:["subarray"],props:{numArgs:1},handler(r,e){var t=De(e[0]),a=t?[e[0]]:H(e[0],"ordgroup").body,i=a.map(function(o){var m=wt(o),c=m.text;if("lc".indexOf(c)!==-1)return{type:"align",align:c};throw new M("Unknown column alignment: "+c,o)});if(i.length>1)throw new M("{subarray} can contain only one column");var s={cols:i,hskipBeforeAndAfter:!1,arraystretch:.5};if(s=U0(r.parser,s,"script"),s.body.length>0&&s.body[0].length>1)throw new M("{subarray} can contain only one column");return s},htmlBuilder:S0,mathmlBuilder:M0});k0({type:"array",names:["cases","dcases","rcases","drcases"],props:{numArgs:0},handler(r){var e={arraystretch:1.2,cols:[{type:"align",align:"l",pregap:0,postgap:1},{type:"align",align:"l",pregap:0,postgap:0}]},t=U0(r.parser,e,Tt(r.envName));return{type:"leftright",mode:r.mode,body:[t],left:r.envName.indexOf("r")>-1?".":"\\{",right:r.envName.indexOf("r")>-1?"\\}":".",rightColor:void 0}},htmlBuilder:S0,mathmlBuilder:M0});k0({type:"array",names:["align","align*","aligned","split"],props:{numArgs:0},handler:Zr,htmlBuilder:S0,mathmlBuilder:M0});k0({type:"array",names:["gathered","gather","gather*"],props:{numArgs:0},handler(r){["gather","gather*"].includes(r.envName)&&He(r);var e={cols:[{type:"align",align:"c"}],addJot:!0,colSeparationType:"gather",autoTag:zt(r.envName),emptySingleRow:!0,leqno:r.parser.settings.leqno};return U0(r.parser,e,"display")},htmlBuilder:S0,mathmlBuilder:M0});k0({type:"array",names:["alignat","alignat*","alignedat"],props:{numArgs:1},handler:Zr,htmlBuilder:S0,mathmlBuilder:M0});k0({type:"array",names:["equation","equation*"],props:{numArgs:0},handler(r){He(r);var e={autoTag:zt(r.envName),emptySingleRow:!0,singleRow:!0,maxNumCols:1,leqno:r.parser.settings.leqno};return U0(r.parser,e,"display")},htmlBuilder:S0,mathmlBuilder:M0});k0({type:"array",names:["CD"],props:{numArgs:0},handler(r){return He(r),q1(r.parser)},htmlBuilder:S0,mathmlBuilder:M0});u("\\nonumber","\\gdef\\@eqnsw{0}");u("\\notag","\\nonumber");B({type:"text",names:["\\hline","\\hdashline"],props:{numArgs:0,allowedInText:!0,allowedInMath:!0},handler(r,e){throw new M(r.funcName+" valid only within array environment")}});var _t=Wr;B({type:"environment",names:["\\begin","\\end"],props:{numArgs:1,argTypes:["text"]},handler(r,e){var{parser:t,funcName:a}=r,i=e[0];if(i.type!=="ordgroup")throw new M("Invalid environment name",i);for(var s="",o=0;o<i.body.length;++o)s+=H(i.body[o],"textord").text;if(a==="\\begin"){if(!_t.hasOwnProperty(s))throw new M("No such environment: "+s,i);var m=_t[s],{args:c,optArgs:p}=t.parseArguments("\\begin{"+s+"}",m),g={mode:t.mode,envName:s,parser:t},y=m.handler(g,c,p);t.expect("\\end",!1);var w=t.nextToken,x=H(t.parseFunction(),"environment");if(x.name!==s)throw new M("Mismatch: \\begin{"+s+"} matched by \\end{"+x.name+"}",w);return y}return{type:"environment",mode:t.mode,name:s,nameGroup:i}}});var Kr=(r,e)=>{var t=r.font,a=e.withFont(t);return F(r.body,a)},Jr=(r,e)=>{var t=r.font,a=e.withFont(t);return X(r.body,a)},er={"\\Bbb":"\\mathbb","\\bold":"\\mathbf","\\frak":"\\mathfrak","\\bm":"\\boldsymbol"};B({type:"font",names:["\\mathrm","\\mathit","\\mathbf","\\mathnormal","\\mathsfit","\\mathbb","\\mathcal","\\mathfrak","\\mathscr","\\mathsf","\\mathtt","\\Bbb","\\bold","\\frak"],props:{numArgs:1,allowedInArgument:!0},handler:(r,e)=>{var{parser:t,funcName:a}=r,i=qe(e[0]),s=a;return s in er&&(s=er[s]),{type:"font",mode:t.mode,font:s.slice(1),body:i}},htmlBuilder:Kr,mathmlBuilder:Jr});B({type:"mclass",names:["\\boldsymbol","\\bm"],props:{numArgs:1},handler:(r,e)=>{var{parser:t}=r,a=e[0],i=V.isCharacterBox(a);return{type:"mclass",mode:t.mode,mclass:Ee(a),body:[{type:"font",mode:t.mode,font:"boldsymbol",body:a}],isCharacterBox:i}}});B({type:"font",names:["\\rm","\\sf","\\tt","\\bf","\\it","\\cal"],props:{numArgs:0,allowedInText:!0},handler:(r,e)=>{var{parser:t,funcName:a,breakOnTokenText:i}=r,{mode:s}=t,o=t.parseExpression(!0,i),m="math"+a.slice(1);return{type:"font",mode:s,font:m,body:{type:"ordgroup",mode:t.mode,body:o}}},htmlBuilder:Kr,mathmlBuilder:Jr});var Qr=(r,e)=>{var t=e;return r==="display"?t=t.id>=I.SCRIPT.id?t.text():I.DISPLAY:r==="text"&&t.size===I.DISPLAY.size?t=I.TEXT:r==="script"?t=I.SCRIPT:r==="scriptscript"&&(t=I.SCRIPTSCRIPT),t},At=(r,e)=>{var t=Qr(r.size,e.style),a=t.fracNum(),i=t.fracDen(),s;s=e.havingStyle(a);var o=F(r.numer,s,e);if(r.continued){var m=8.5/e.fontMetrics().ptPerEm,c=3.5/e.fontMetrics().ptPerEm;o.height=o.height<m?m:o.height,o.depth=o.depth<c?c:o.depth}s=e.havingStyle(i);var p=F(r.denom,s,e),g,y,w;r.hasBarLine?(r.barSize?(y=K(r.barSize,e),g=b.makeLineSpan("frac-line",e,y)):g=b.makeLineSpan("frac-line",e),y=g.height,w=g.height):(g=null,y=0,w=e.fontMetrics().defaultRuleThickness);var x,z,A;t.size===I.DISPLAY.size||r.size==="display"?(x=e.fontMetrics().num1,y>0?z=3*w:z=7*w,A=e.fontMetrics().denom1):(y>0?(x=e.fontMetrics().num2,z=w):(x=e.fontMetrics().num3,z=3*w),A=e.fontMetrics().denom2);var C;if(g){var E=e.fontMetrics().axisHeight;x-o.depth-(E+.5*y)<z&&(x+=z-(x-o.depth-(E+.5*y))),E-.5*y-(p.height-A)<z&&(A+=z-(E-.5*y-(p.height-A)));var O=-(E-.5*y);C=b.makeVList({positionType:"individualShift",children:[{type:"elem",elem:p,shift:A},{type:"elem",elem:g,shift:O},{type:"elem",elem:o,shift:-x}]},e)}else{var q=x-o.depth-(p.height-A);q<z&&(x+=.5*(z-q),A+=.5*(z-q)),C=b.makeVList({positionType:"individualShift",children:[{type:"elem",elem:p,shift:A},{type:"elem",elem:o,shift:-x}]},e)}s=e.havingStyle(t),C.height*=s.sizeMultiplier/e.sizeMultiplier,C.depth*=s.sizeMultiplier/e.sizeMultiplier;var G;t.size===I.DISPLAY.size?G=e.fontMetrics().delim1:t.size===I.SCRIPTSCRIPT.size?G=e.havingStyle(I.SCRIPT).fontMetrics().delim2:G=e.fontMetrics().delim2;var L,U;return r.leftDelim==null?L=oe(e,["mopen"]):L=N0.customSizedDelim(r.leftDelim,G,!0,e.havingStyle(t),r.mode,["mopen"]),r.continued?U=b.makeSpan([]):r.rightDelim==null?U=oe(e,["mclose"]):U=N0.customSizedDelim(r.rightDelim,G,!0,e.havingStyle(t),r.mode,["mclose"]),b.makeSpan(["mord"].concat(s.sizingClasses(e)),[L,b.makeSpan(["mfrac"],[C]),U],e)},Bt=(r,e)=>{var t=new S.MathNode("mfrac",[X(r.numer,e),X(r.denom,e)]);if(!r.hasBarLine)t.setAttribute("linethickness","0px");else if(r.barSize){var a=K(r.barSize,e);t.setAttribute("linethickness",T(a))}var i=Qr(r.size,e.style);if(i.size!==e.style.size){t=new S.MathNode("mstyle",[t]);var s=i.size===I.DISPLAY.size?"true":"false";t.setAttribute("displaystyle",s),t.setAttribute("scriptlevel","0")}if(r.leftDelim!=null||r.rightDelim!=null){var o=[];if(r.leftDelim!=null){var m=new S.MathNode("mo",[new S.TextNode(r.leftDelim.replace("\\",""))]);m.setAttribute("fence","true"),o.push(m)}if(o.push(t),r.rightDelim!=null){var c=new S.MathNode("mo",[new S.TextNode(r.rightDelim.replace("\\",""))]);c.setAttribute("fence","true"),o.push(c)}return bt(o)}return t};B({type:"genfrac",names:["\\dfrac","\\frac","\\tfrac","\\dbinom","\\binom","\\tbinom","\\\\atopfrac","\\\\bracefrac","\\\\brackfrac"],props:{numArgs:2,allowedInArgument:!0},handler:(r,e)=>{var{parser:t,funcName:a}=r,i=e[0],s=e[1],o,m=null,c=null,p="auto";switch(a){case"\\dfrac":case"\\frac":case"\\tfrac":o=!0;break;case"\\\\atopfrac":o=!1;break;case"\\dbinom":case"\\binom":case"\\tbinom":o=!1,m="(",c=")";break;case"\\\\bracefrac":o=!1,m="\\{",c="\\}";break;case"\\\\brackfrac":o=!1,m="[",c="]";break;default:throw new Error("Unrecognized genfrac command")}switch(a){case"\\dfrac":case"\\dbinom":p="display";break;case"\\tfrac":case"\\tbinom":p="text";break}return{type:"genfrac",mode:t.mode,continued:!1,numer:i,denom:s,hasBarLine:o,leftDelim:m,rightDelim:c,size:p,barSize:null}},htmlBuilder:At,mathmlBuilder:Bt});B({type:"genfrac",names:["\\cfrac"],props:{numArgs:2},handler:(r,e)=>{var{parser:t,funcName:a}=r,i=e[0],s=e[1];return{type:"genfrac",mode:t.mode,continued:!0,numer:i,denom:s,hasBarLine:!0,leftDelim:null,rightDelim:null,size:"display",barSize:null}}});B({type:"infix",names:["\\over","\\choose","\\atop","\\brace","\\brack"],props:{numArgs:0,infix:!0},handler(r){var{parser:e,funcName:t,token:a}=r,i;switch(t){case"\\over":i="\\frac";break;case"\\choose":i="\\binom";break;case"\\atop":i="\\\\atopfrac";break;case"\\brace":i="\\\\bracefrac";break;case"\\brack":i="\\\\brackfrac";break;default:throw new Error("Unrecognized infix genfrac command")}return{type:"infix",mode:e.mode,replaceWith:i,token:a}}});var tr=["display","text","script","scriptscript"],rr=function(e){var t=null;return e.length>0&&(t=e,t=t==="."?null:t),t};B({type:"genfrac",names:["\\genfrac"],props:{numArgs:6,allowedInArgument:!0,argTypes:["math","math","size","text","math","math"]},handler(r,e){var{parser:t}=r,a=e[4],i=e[5],s=qe(e[0]),o=s.type==="atom"&&s.family==="open"?rr(s.text):null,m=qe(e[1]),c=m.type==="atom"&&m.family==="close"?rr(m.text):null,p=H(e[2],"size"),g,y=null;p.isBlank?g=!0:(y=p.value,g=y.number>0);var w="auto",x=e[3];if(x.type==="ordgroup"){if(x.body.length>0){var z=H(x.body[0],"textord");w=tr[Number(z.text)]}}else x=H(x,"textord"),w=tr[Number(x.text)];return{type:"genfrac",mode:t.mode,numer:a,denom:i,continued:!1,hasBarLine:g,barSize:y,leftDelim:o,rightDelim:c,size:w}},htmlBuilder:At,mathmlBuilder:Bt});B({type:"infix",names:["\\above"],props:{numArgs:1,argTypes:["size"],infix:!0},handler(r,e){var{parser:t,funcName:a,token:i}=r;return{type:"infix",mode:t.mode,replaceWith:"\\\\abovefrac",size:H(e[0],"size").value,token:i}}});B({type:"genfrac",names:["\\\\abovefrac"],props:{numArgs:3,argTypes:["math","size","math"]},handler:(r,e)=>{var{parser:t,funcName:a}=r,i=e[0],s=xa(H(e[1],"infix").size),o=e[2],m=s.number>0;return{type:"genfrac",mode:t.mode,numer:i,denom:o,continued:!1,hasBarLine:m,barSize:s,leftDelim:null,rightDelim:null,size:"auto"}},htmlBuilder:At,mathmlBuilder:Bt});var _r=(r,e)=>{var t=e.style,a,i;r.type==="supsub"?(a=r.sup?F(r.sup,e.havingStyle(t.sup()),e):F(r.sub,e.havingStyle(t.sub()),e),i=H(r.base,"horizBrace")):i=H(r,"horizBrace");var s=F(i.base,e.havingBaseStyle(I.DISPLAY)),o=R0.svgSpan(i,e),m;if(i.isOver?(m=b.makeVList({positionType:"firstBaseline",children:[{type:"elem",elem:s},{type:"kern",size:.1},{type:"elem",elem:o}]},e),m.children[0].children[0].children[1].classes.push("svg-align")):(m=b.makeVList({positionType:"bottom",positionData:s.depth+.1+o.height,children:[{type:"elem",elem:o},{type:"kern",size:.1},{type:"elem",elem:s}]},e),m.children[0].children[0].children[0].classes.push("svg-align")),a){var c=b.makeSpan(["mord",i.isOver?"mover":"munder"],[m],e);i.isOver?m=b.makeVList({positionType:"firstBaseline",children:[{type:"elem",elem:c},{type:"kern",size:.2},{type:"elem",elem:a}]},e):m=b.makeVList({positionType:"bottom",positionData:c.depth+.2+a.height+a.depth,children:[{type:"elem",elem:a},{type:"kern",size:.2},{type:"elem",elem:c}]},e)}return b.makeSpan(["mord",i.isOver?"mover":"munder"],[m],e)},$1=(r,e)=>{var t=R0.mathMLnode(r.label);return new S.MathNode(r.isOver?"mover":"munder",[X(r.base,e),t])};B({type:"horizBrace",names:["\\overbrace","\\underbrace"],props:{numArgs:1},handler(r,e){var{parser:t,funcName:a}=r;return{type:"horizBrace",mode:t.mode,label:a,isOver:/^\\over/.test(a),base:e[0]}},htmlBuilder:_r,mathmlBuilder:$1});B({type:"href",names:["\\href"],props:{numArgs:2,argTypes:["url","original"],allowedInText:!0},handler:(r,e)=>{var{parser:t}=r,a=e[1],i=H(e[0],"url").url;return t.settings.isTrusted({command:"\\href",url:i})?{type:"href",mode:t.mode,href:i,body:Q(a)}:t.formatUnsupportedCmd("\\href")},htmlBuilder:(r,e)=>{var t=t0(r.body,e,!1);return b.makeAnchor(r.href,[],t,e)},mathmlBuilder:(r,e)=>{var t=G0(r.body,e);return t instanceof m0||(t=new m0("mrow",[t])),t.setAttribute("href",r.href),t}});B({type:"href",names:["\\url"],props:{numArgs:1,argTypes:["url"],allowedInText:!0},handler:(r,e)=>{var{parser:t}=r,a=H(e[0],"url").url;if(!t.settings.isTrusted({command:"\\url",url:a}))return t.formatUnsupportedCmd("\\url");for(var i=[],s=0;s<a.length;s++){var o=a[s];o==="~"&&(o="\\textasciitilde"),i.push({type:"textord",mode:"text",text:o})}var m={type:"text",mode:t.mode,font:"\\texttt",body:i};return{type:"href",mode:t.mode,href:a,body:Q(m)}}});B({type:"hbox",names:["\\hbox"],props:{numArgs:1,argTypes:["text"],allowedInText:!0,primitive:!0},handler(r,e){var{parser:t}=r;return{type:"hbox",mode:t.mode,body:Q(e[0])}},htmlBuilder(r,e){var t=t0(r.body,e,!1);return b.makeFragment(t)},mathmlBuilder(r,e){return new S.MathNode("mrow",h0(r.body,e))}});B({type:"html",names:["\\htmlClass","\\htmlId","\\htmlStyle","\\htmlData"],props:{numArgs:2,argTypes:["raw","original"],allowedInText:!0},handler:(r,e)=>{var{parser:t,funcName:a,token:i}=r,s=H(e[0],"raw").string,o=e[1];t.settings.strict&&t.settings.reportNonstrict("htmlExtension","HTML extension is disabled on strict mode");var m,c={};switch(a){case"\\htmlClass":c.class=s,m={command:"\\htmlClass",class:s};break;case"\\htmlId":c.id=s,m={command:"\\htmlId",id:s};break;case"\\htmlStyle":c.style=s,m={command:"\\htmlStyle",style:s};break;case"\\htmlData":{for(var p=s.split(","),g=0;g<p.length;g++){var y=p[g],w=y.indexOf("=");if(w<0)throw new M("\\htmlData key/value '"+y+"' missing equals sign");var x=y.slice(0,w),z=y.slice(w+1);c["data-"+x.trim()]=z}m={command:"\\htmlData",attributes:c};break}default:throw new Error("Unrecognized html command")}return t.settings.isTrusted(m)?{type:"html",mode:t.mode,attributes:c,body:Q(o)}:t.formatUnsupportedCmd(a)},htmlBuilder:(r,e)=>{var t=t0(r.body,e,!1),a=["enclosing"];r.attributes.class&&a.push(...r.attributes.class.trim().split(/\s+/));var i=b.makeSpan(a,t,e);for(var s in r.attributes)s!=="class"&&r.attributes.hasOwnProperty(s)&&i.setAttribute(s,r.attributes[s]);return i},mathmlBuilder:(r,e)=>G0(r.body,e)});B({type:"htmlmathml",names:["\\html@mathml"],props:{numArgs:2,allowedInText:!0},handler:(r,e)=>{var{parser:t}=r;return{type:"htmlmathml",mode:t.mode,html:Q(e[0]),mathml:Q(e[1])}},htmlBuilder:(r,e)=>{var t=t0(r.html,e,!1);return b.makeFragment(t)},mathmlBuilder:(r,e)=>G0(r.mathml,e)});var et=function(e){if(/^[-+]? *(\d+(\.\d*)?|\.\d+)$/.test(e))return{number:+e,unit:"bp"};var t=/([-+]?) *(\d+(?:\.\d*)?|\.\d+) *([a-z]{2})/.exec(e);if(!t)throw new M("Invalid size: '"+e+"' in \\includegraphics");var a={number:+(t[1]+t[2]),unit:t[3]};if(!br(a))throw new M("Invalid unit: '"+a.unit+"' in \\includegraphics.");return a};B({type:"includegraphics",names:["\\includegraphics"],props:{numArgs:1,numOptionalArgs:1,argTypes:["raw","url"],allowedInText:!1},handler:(r,e,t)=>{var{parser:a}=r,i={number:0,unit:"em"},s={number:.9,unit:"em"},o={number:0,unit:"em"},m="";if(t[0])for(var c=H(t[0],"raw").string,p=c.split(","),g=0;g<p.length;g++){var y=p[g].split("=");if(y.length===2){var w=y[1].trim();switch(y[0].trim()){case"alt":m=w;break;case"width":i=et(w);break;case"height":s=et(w);break;case"totalheight":o=et(w);break;default:throw new M("Invalid key: '"+y[0]+"' in \\includegraphics.")}}}var x=H(e[0],"url").url;return m===""&&(m=x,m=m.replace(/^.*[\\/]/,""),m=m.substring(0,m.lastIndexOf("."))),a.settings.isTrusted({command:"\\includegraphics",url:x})?{type:"includegraphics",mode:a.mode,alt:m,width:i,height:s,totalheight:o,src:x}:a.formatUnsupportedCmd("\\includegraphics")},htmlBuilder:(r,e)=>{var t=K(r.height,e),a=0;r.totalheight.number>0&&(a=K(r.totalheight,e)-t);var i=0;r.width.number>0&&(i=K(r.width,e));var s={height:T(t+a)};i>0&&(s.width=T(i)),a>0&&(s.verticalAlign=T(-a));var o=new $a(r.src,r.alt,s);return o.height=t,o.depth=a,o},mathmlBuilder:(r,e)=>{var t=new S.MathNode("mglyph",[]);t.setAttribute("alt",r.alt);var a=K(r.height,e),i=0;if(r.totalheight.number>0&&(i=K(r.totalheight,e)-a,t.setAttribute("valign",T(-i))),t.setAttribute("height",T(a+i)),r.width.number>0){var s=K(r.width,e);t.setAttribute("width",T(s))}return t.setAttribute("src",r.src),t}});B({type:"kern",names:["\\kern","\\mkern","\\hskip","\\mskip"],props:{numArgs:1,argTypes:["size"],primitive:!0,allowedInText:!0},handler(r,e){var{parser:t,funcName:a}=r,i=H(e[0],"size");if(t.settings.strict){var s=a[1]==="m",o=i.value.unit==="mu";s?(o||t.settings.reportNonstrict("mathVsTextUnits","LaTeX's "+a+" supports only mu units, "+("not "+i.value.unit+" units")),t.mode!=="math"&&t.settings.reportNonstrict("mathVsTextUnits","LaTeX's "+a+" works only in math mode")):o&&t.settings.reportNonstrict("mathVsTextUnits","LaTeX's "+a+" doesn't support mu units")}return{type:"kern",mode:t.mode,dimension:i.value}},htmlBuilder(r,e){return b.makeGlue(r.dimension,e)},mathmlBuilder(r,e){var t=K(r.dimension,e);return new S.SpaceNode(t)}});B({type:"lap",names:["\\mathllap","\\mathrlap","\\mathclap"],props:{numArgs:1,allowedInText:!0},handler:(r,e)=>{var{parser:t,funcName:a}=r,i=e[0];return{type:"lap",mode:t.mode,alignment:a.slice(5),body:i}},htmlBuilder:(r,e)=>{var t;r.alignment==="clap"?(t=b.makeSpan([],[F(r.body,e)]),t=b.makeSpan(["inner"],[t],e)):t=b.makeSpan(["inner"],[F(r.body,e)]);var a=b.makeSpan(["fix"],[]),i=b.makeSpan([r.alignment],[t,a],e),s=b.makeSpan(["strut"]);return s.style.height=T(i.height+i.depth),i.depth&&(s.style.verticalAlign=T(-i.depth)),i.children.unshift(s),i=b.makeSpan(["thinbox"],[i],e),b.makeSpan(["mord","vbox"],[i],e)},mathmlBuilder:(r,e)=>{var t=new S.MathNode("mpadded",[X(r.body,e)]);if(r.alignment!=="rlap"){var a=r.alignment==="llap"?"-1":"-0.5";t.setAttribute("lspace",a+"width")}return t.setAttribute("width","0px"),t}});B({type:"styling",names:["\\(","$"],props:{numArgs:0,allowedInText:!0,allowedInMath:!1},handler(r,e){var{funcName:t,parser:a}=r,i=a.mode;a.switchMode("math");var s=t==="\\("?"\\)":"$",o=a.parseExpression(!1,s);return a.expect(s),a.switchMode(i),{type:"styling",mode:a.mode,style:"text",body:o}}});B({type:"text",names:["\\)","\\]"],props:{numArgs:0,allowedInText:!0,allowedInMath:!1},handler(r,e){throw new M("Mismatched "+r.funcName)}});var ar=(r,e)=>{switch(e.style.size){case I.DISPLAY.size:return r.display;case I.TEXT.size:return r.text;case I.SCRIPT.size:return r.script;case I.SCRIPTSCRIPT.size:return r.scriptscript;default:return r.text}};B({type:"mathchoice",names:["\\mathchoice"],props:{numArgs:4,primitive:!0},handler:(r,e)=>{var{parser:t}=r;return{type:"mathchoice",mode:t.mode,display:Q(e[0]),text:Q(e[1]),script:Q(e[2]),scriptscript:Q(e[3])}},htmlBuilder:(r,e)=>{var t=ar(r,e),a=t0(t,e,!1);return b.makeFragment(a)},mathmlBuilder:(r,e)=>{var t=ar(r,e);return G0(t,e)}});var ea=(r,e,t,a,i,s,o)=>{r=b.makeSpan([],[r]);var m=t&&V.isCharacterBox(t),c,p;if(e){var g=F(e,a.havingStyle(i.sup()),a);p={elem:g,kern:Math.max(a.fontMetrics().bigOpSpacing1,a.fontMetrics().bigOpSpacing3-g.depth)}}if(t){var y=F(t,a.havingStyle(i.sub()),a);c={elem:y,kern:Math.max(a.fontMetrics().bigOpSpacing2,a.fontMetrics().bigOpSpacing4-y.height)}}var w;if(p&&c){var x=a.fontMetrics().bigOpSpacing5+c.elem.height+c.elem.depth+c.kern+r.depth+o;w=b.makeVList({positionType:"bottom",positionData:x,children:[{type:"kern",size:a.fontMetrics().bigOpSpacing5},{type:"elem",elem:c.elem,marginLeft:T(-s)},{type:"kern",size:c.kern},{type:"elem",elem:r},{type:"kern",size:p.kern},{type:"elem",elem:p.elem,marginLeft:T(s)},{type:"kern",size:a.fontMetrics().bigOpSpacing5}]},a)}else if(c){var z=r.height-o;w=b.makeVList({positionType:"top",positionData:z,children:[{type:"kern",size:a.fontMetrics().bigOpSpacing5},{type:"elem",elem:c.elem,marginLeft:T(-s)},{type:"kern",size:c.kern},{type:"elem",elem:r}]},a)}else if(p){var A=r.depth+o;w=b.makeVList({positionType:"bottom",positionData:A,children:[{type:"elem",elem:r},{type:"kern",size:p.kern},{type:"elem",elem:p.elem,marginLeft:T(s)},{type:"kern",size:a.fontMetrics().bigOpSpacing5}]},a)}else return r;var C=[w];if(c&&s!==0&&!m){var q=b.makeSpan(["mspace"],[],a);q.style.marginRight=T(s),C.unshift(q)}return b.makeSpan(["mop","op-limits"],C,a)},ta=["\\smallint"],ae=(r,e)=>{var t,a,i=!1,s;r.type==="supsub"?(t=r.sup,a=r.sub,s=H(r.base,"op"),i=!0):s=H(r,"op");var o=e.style,m=!1;o.size===I.DISPLAY.size&&s.symbol&&!ta.includes(s.name)&&(m=!0);var c;if(s.symbol){var p=m?"Size2-Regular":"Size1-Regular",g="";if((s.name==="\\oiint"||s.name==="\\oiiint")&&(g=s.name.slice(1),s.name=g==="oiint"?"\\iint":"\\iiint"),c=b.makeSymbol(s.name,p,"math",e,["mop","op-symbol",m?"large-op":"small-op"]),g.length>0){var y=c.italic,w=b.staticSvg(g+"Size"+(m?"2":"1"),e);c=b.makeVList({positionType:"individualShift",children:[{type:"elem",elem:c,shift:0},{type:"elem",elem:w,shift:m?.08:0}]},e),s.name="\\"+g,c.classes.unshift("mop"),c.italic=y}}else if(s.body){var x=t0(s.body,e,!0);x.length===1&&x[0]instanceof p0?(c=x[0],c.classes[0]="mop"):c=b.makeSpan(["mop"],x,e)}else{for(var z=[],A=1;A<s.name.length;A++)z.push(b.mathsym(s.name[A],s.mode,e));c=b.makeSpan(["mop"],z,e)}var C=0,q=0;return(c instanceof p0||s.name==="\\oiint"||s.name==="\\oiiint")&&!s.suppressBaseShift&&(C=(c.height-c.depth)/2-e.fontMetrics().axisHeight,q=c.italic),i?ea(c,t,a,e,o,q,C):(C&&(c.style.position="relative",c.style.top=T(C)),c)},ue=(r,e)=>{var t;if(r.symbol)t=new m0("mo",[v0(r.name,r.mode)]),ta.includes(r.name)&&t.setAttribute("largeop","false");else if(r.body)t=new m0("mo",h0(r.body,e));else{t=new m0("mi",[new x0(r.name.slice(1))]);var a=new m0("mo",[v0("⁡","text")]);r.parentIsSupSub?t=new m0("mrow",[t,a]):t=Nr([t,a])}return t},W1={"∏":"\\prod","∐":"\\coprod","∑":"\\sum","⋀":"\\bigwedge","⋁":"\\bigvee","⋂":"\\bigcap","⋃":"\\bigcup","⨀":"\\bigodot","⨁":"\\bigoplus","⨂":"\\bigotimes","⨄":"\\biguplus","⨆":"\\bigsqcup"};B({type:"op",names:["\\coprod","\\bigvee","\\bigwedge","\\biguplus","\\bigcap","\\bigcup","\\intop","\\prod","\\sum","\\bigotimes","\\bigoplus","\\bigodot","\\bigsqcup","\\smallint","∏","∐","∑","⋀","⋁","⋂","⋃","⨀","⨁","⨂","⨄","⨆"],props:{numArgs:0},handler:(r,e)=>{var{parser:t,funcName:a}=r,i=a;return i.length===1&&(i=W1[i]),{type:"op",mode:t.mode,limits:!0,parentIsSupSub:!1,symbol:!0,name:i}},htmlBuilder:ae,mathmlBuilder:ue});B({type:"op",names:["\\mathop"],props:{numArgs:1,primitive:!0},handler:(r,e)=>{var{parser:t}=r,a=e[0];return{type:"op",mode:t.mode,limits:!1,parentIsSupSub:!1,symbol:!1,body:Q(a)}},htmlBuilder:ae,mathmlBuilder:ue});var j1={"∫":"\\int","∬":"\\iint","∭":"\\iiint","∮":"\\oint","∯":"\\oiint","∰":"\\oiiint"};B({type:"op",names:["\\arcsin","\\arccos","\\arctan","\\arctg","\\arcctg","\\arg","\\ch","\\cos","\\cosec","\\cosh","\\cot","\\cotg","\\coth","\\csc","\\ctg","\\cth","\\deg","\\dim","\\exp","\\hom","\\ker","\\lg","\\ln","\\log","\\sec","\\sin","\\sinh","\\sh","\\tan","\\tanh","\\tg","\\th"],props:{numArgs:0},handler(r){var{parser:e,funcName:t}=r;return{type:"op",mode:e.mode,limits:!1,parentIsSupSub:!1,symbol:!1,name:t}},htmlBuilder:ae,mathmlBuilder:ue});B({type:"op",names:["\\det","\\gcd","\\inf","\\lim","\\max","\\min","\\Pr","\\sup"],props:{numArgs:0},handler(r){var{parser:e,funcName:t}=r;return{type:"op",mode:e.mode,limits:!0,parentIsSupSub:!1,symbol:!1,name:t}},htmlBuilder:ae,mathmlBuilder:ue});B({type:"op",names:["\\int","\\iint","\\iiint","\\oint","\\oiint","\\oiiint","∫","∬","∭","∮","∯","∰"],props:{numArgs:0,allowedInArgument:!0},handler(r){var{parser:e,funcName:t}=r,a=t;return a.length===1&&(a=j1[a]),{type:"op",mode:e.mode,limits:!1,parentIsSupSub:!1,symbol:!0,name:a}},htmlBuilder:ae,mathmlBuilder:ue});var ra=(r,e)=>{var t,a,i=!1,s;r.type==="supsub"?(t=r.sup,a=r.sub,s=H(r.base,"operatorname"),i=!0):s=H(r,"operatorname");var o;if(s.body.length>0){for(var m=s.body.map(y=>{var w=y.text;return typeof w=="string"?{type:"textord",mode:y.mode,text:w}:y}),c=t0(m,e.withFont("mathrm"),!0),p=0;p<c.length;p++){var g=c[p];g instanceof p0&&(g.text=g.text.replace(/\u2212/,"-").replace(/\u2217/,"*"))}o=b.makeSpan(["mop"],c,e)}else o=b.makeSpan(["mop"],[],e);return i?ea(o,t,a,e,e.style,0,0):o},Z1=(r,e)=>{for(var t=h0(r.body,e.withFont("mathrm")),a=!0,i=0;i<t.length;i++){var s=t[i];if(!(s instanceof S.SpaceNode))if(s instanceof S.MathNode)switch(s.type){case"mi":case"mn":case"ms":case"mspace":case"mtext":break;case"mo":{var o=s.children[0];s.children.length===1&&o instanceof S.TextNode?o.text=o.text.replace(/\u2212/,"-").replace(/\u2217/,"*"):a=!1;break}default:a=!1}else a=!1}if(a){var m=t.map(g=>g.toText()).join("");t=[new S.TextNode(m)]}var c=new S.MathNode("mi",t);c.setAttribute("mathvariant","normal");var p=new S.MathNode("mo",[v0("⁡","text")]);return r.parentIsSupSub?new S.MathNode("mrow",[c,p]):S.newDocumentFragment([c,p])};B({type:"operatorname",names:["\\operatorname@","\\operatornamewithlimits"],props:{numArgs:1},handler:(r,e)=>{var{parser:t,funcName:a}=r,i=e[0];return{type:"operatorname",mode:t.mode,body:Q(i),alwaysHandleSupSub:a==="\\operatornamewithlimits",limits:!1,parentIsSupSub:!1}},htmlBuilder:ra,mathmlBuilder:Z1});u("\\operatorname","\\@ifstar\\operatornamewithlimits\\operatorname@");W0({type:"ordgroup",htmlBuilder(r,e){return r.semisimple?b.makeFragment(t0(r.body,e,!1)):b.makeSpan(["mord"],t0(r.body,e,!0),e)},mathmlBuilder(r,e){return G0(r.body,e,!0)}});B({type:"overline",names:["\\overline"],props:{numArgs:1},handler(r,e){var{parser:t}=r,a=e[0];return{type:"overline",mode:t.mode,body:a}},htmlBuilder(r,e){var t=F(r.body,e.havingCrampedStyle()),a=b.makeLineSpan("overline-line",e),i=e.fontMetrics().defaultRuleThickness,s=b.makeVList({positionType:"firstBaseline",children:[{type:"elem",elem:t},{type:"kern",size:3*i},{type:"elem",elem:a},{type:"kern",size:i}]},e);return b.makeSpan(["mord","overline"],[s],e)},mathmlBuilder(r,e){var t=new S.MathNode("mo",[new S.TextNode("‾")]);t.setAttribute("stretchy","true");var a=new S.MathNode("mover",[X(r.body,e),t]);return a.setAttribute("accent","true"),a}});B({type:"phantom",names:["\\phantom"],props:{numArgs:1,allowedInText:!0},handler:(r,e)=>{var{parser:t}=r,a=e[0];return{type:"phantom",mode:t.mode,body:Q(a)}},htmlBuilder:(r,e)=>{var t=t0(r.body,e.withPhantom(),!1);return b.makeFragment(t)},mathmlBuilder:(r,e)=>{var t=h0(r.body,e);return new S.MathNode("mphantom",t)}});B({type:"hphantom",names:["\\hphantom"],props:{numArgs:1,allowedInText:!0},handler:(r,e)=>{var{parser:t}=r,a=e[0];return{type:"hphantom",mode:t.mode,body:a}},htmlBuilder:(r,e)=>{var t=b.makeSpan([],[F(r.body,e.withPhantom())]);if(t.height=0,t.depth=0,t.children)for(var a=0;a<t.children.length;a++)t.children[a].height=0,t.children[a].depth=0;return t=b.makeVList({positionType:"firstBaseline",children:[{type:"elem",elem:t}]},e),b.makeSpan(["mord"],[t],e)},mathmlBuilder:(r,e)=>{var t=h0(Q(r.body),e),a=new S.MathNode("mphantom",t),i=new S.MathNode("mpadded",[a]);return i.setAttribute("height","0px"),i.setAttribute("depth","0px"),i}});B({type:"vphantom",names:["\\vphantom"],props:{numArgs:1,allowedInText:!0},handler:(r,e)=>{var{parser:t}=r,a=e[0];return{type:"vphantom",mode:t.mode,body:a}},htmlBuilder:(r,e)=>{var t=b.makeSpan(["inner"],[F(r.body,e.withPhantom())]),a=b.makeSpan(["fix"],[]);return b.makeSpan(["mord","rlap"],[t,a],e)},mathmlBuilder:(r,e)=>{var t=h0(Q(r.body),e),a=new S.MathNode("mphantom",t),i=new S.MathNode("mpadded",[a]);return i.setAttribute("width","0px"),i}});B({type:"raisebox",names:["\\raisebox"],props:{numArgs:2,argTypes:["size","hbox"],allowedInText:!0},handler(r,e){var{parser:t}=r,a=H(e[0],"size").value,i=e[1];return{type:"raisebox",mode:t.mode,dy:a,body:i}},htmlBuilder(r,e){var t=F(r.body,e),a=K(r.dy,e);return b.makeVList({positionType:"shift",positionData:-a,children:[{type:"elem",elem:t}]},e)},mathmlBuilder(r,e){var t=new S.MathNode("mpadded",[X(r.body,e)]),a=r.dy.number+r.dy.unit;return t.setAttribute("voffset",a),t}});B({type:"internal",names:["\\relax"],props:{numArgs:0,allowedInText:!0,allowedInArgument:!0},handler(r){var{parser:e}=r;return{type:"internal",mode:e.mode}}});B({type:"rule",names:["\\rule"],props:{numArgs:2,numOptionalArgs:1,allowedInText:!0,allowedInMath:!0,argTypes:["size","size","size"]},handler(r,e,t){var{parser:a}=r,i=t[0],s=H(e[0],"size"),o=H(e[1],"size");return{type:"rule",mode:a.mode,shift:i&&H(i,"size").value,width:s.value,height:o.value}},htmlBuilder(r,e){var t=b.makeSpan(["mord","rule"],[],e),a=K(r.width,e),i=K(r.height,e),s=r.shift?K(r.shift,e):0;return t.style.borderRightWidth=T(a),t.style.borderTopWidth=T(i),t.style.bottom=T(s),t.width=a,t.height=i+s,t.depth=-s,t.maxFontSize=i*1.125*e.sizeMultiplier,t},mathmlBuilder(r,e){var t=K(r.width,e),a=K(r.height,e),i=r.shift?K(r.shift,e):0,s=e.color&&e.getColor()||"black",o=new S.MathNode("mspace");o.setAttribute("mathbackground",s),o.setAttribute("width",T(t)),o.setAttribute("height",T(a));var m=new S.MathNode("mpadded",[o]);return i>=0?m.setAttribute("height",T(i)):(m.setAttribute("height",T(i)),m.setAttribute("depth",T(-i))),m.setAttribute("voffset",T(i)),m}});function aa(r,e,t){for(var a=t0(r,e,!1),i=e.sizeMultiplier/t.sizeMultiplier,s=0;s<a.length;s++){var o=a[s].classes.indexOf("sizing");o<0?Array.prototype.push.apply(a[s].classes,e.sizingClasses(t)):a[s].classes[o+1]==="reset-size"+e.size&&(a[s].classes[o+1]="reset-size"+t.size),a[s].height*=i,a[s].depth*=i}return b.makeFragment(a)}var ir=["\\tiny","\\sixptsize","\\scriptsize","\\footnotesize","\\small","\\normalsize","\\large","\\Large","\\LARGE","\\huge","\\Huge"],K1=(r,e)=>{var t=e.havingSize(r.size);return aa(r.body,t,e)};B({type:"sizing",names:ir,props:{numArgs:0,allowedInText:!0},handler:(r,e)=>{var{breakOnTokenText:t,funcName:a,parser:i}=r,s=i.parseExpression(!1,t);return{type:"sizing",mode:i.mode,size:ir.indexOf(a)+1,body:s}},htmlBuilder:K1,mathmlBuilder:(r,e)=>{var t=e.havingSize(r.size),a=h0(r.body,t),i=new S.MathNode("mstyle",a);return i.setAttribute("mathsize",T(t.sizeMultiplier)),i}});B({type:"smash",names:["\\smash"],props:{numArgs:1,numOptionalArgs:1,allowedInText:!0},handler:(r,e,t)=>{var{parser:a}=r,i=!1,s=!1,o=t[0]&&H(t[0],"ordgroup");if(o)for(var m="",c=0;c<o.body.length;++c){var p=o.body[c];if(m=p.text,m==="t")i=!0;else if(m==="b")s=!0;else{i=!1,s=!1;break}}else i=!0,s=!0;var g=e[0];return{type:"smash",mode:a.mode,body:g,smashHeight:i,smashDepth:s}},htmlBuilder:(r,e)=>{var t=b.makeSpan([],[F(r.body,e)]);if(!r.smashHeight&&!r.smashDepth)return t;if(r.smashHeight&&(t.height=0,t.children))for(var a=0;a<t.children.length;a++)t.children[a].height=0;if(r.smashDepth&&(t.depth=0,t.children))for(var i=0;i<t.children.length;i++)t.children[i].depth=0;var s=b.makeVList({positionType:"firstBaseline",children:[{type:"elem",elem:t}]},e);return b.makeSpan(["mord"],[s],e)},mathmlBuilder:(r,e)=>{var t=new S.MathNode("mpadded",[X(r.body,e)]);return r.smashHeight&&t.setAttribute("height","0px"),r.smashDepth&&t.setAttribute("depth","0px"),t}});B({type:"sqrt",names:["\\sqrt"],props:{numArgs:1,numOptionalArgs:1},handler(r,e,t){var{parser:a}=r,i=t[0],s=e[0];return{type:"sqrt",mode:a.mode,body:s,index:i}},htmlBuilder(r,e){var t=F(r.body,e.havingCrampedStyle());t.height===0&&(t.height=e.fontMetrics().xHeight),t=b.wrapFragment(t,e);var a=e.fontMetrics(),i=a.defaultRuleThickness,s=i;e.style.id<I.TEXT.id&&(s=e.fontMetrics().xHeight);var o=i+s/4,m=t.height+t.depth+o+i,{span:c,ruleWidth:p,advanceWidth:g}=N0.sqrtImage(m,e),y=c.height-p;y>t.height+t.depth+o&&(o=(o+y-t.height-t.depth)/2);var w=c.height-t.height-o-p;t.style.paddingLeft=T(g);var x=b.makeVList({positionType:"firstBaseline",children:[{type:"elem",elem:t,wrapperClasses:["svg-align"]},{type:"kern",size:-(t.height+w)},{type:"elem",elem:c},{type:"kern",size:p}]},e);if(r.index){var z=e.havingStyle(I.SCRIPTSCRIPT),A=F(r.index,z,e),C=.6*(x.height-x.depth),q=b.makeVList({positionType:"shift",positionData:-C,children:[{type:"elem",elem:A}]},e),E=b.makeSpan(["root"],[q]);return b.makeSpan(["mord","sqrt"],[E,x],e)}else return b.makeSpan(["mord","sqrt"],[x],e)},mathmlBuilder(r,e){var{body:t,index:a}=r;return a?new S.MathNode("mroot",[X(t,e),X(a,e)]):new S.MathNode("msqrt",[X(t,e)])}});var nr={display:I.DISPLAY,text:I.TEXT,script:I.SCRIPT,scriptscript:I.SCRIPTSCRIPT};B({type:"styling",names:["\\displaystyle","\\textstyle","\\scriptstyle","\\scriptscriptstyle"],props:{numArgs:0,allowedInText:!0,primitive:!0},handler(r,e){var{breakOnTokenText:t,funcName:a,parser:i}=r,s=i.parseExpression(!0,t),o=a.slice(1,a.length-5);return{type:"styling",mode:i.mode,style:o,body:s}},htmlBuilder(r,e){var t=nr[r.style],a=e.havingStyle(t).withFont("");return aa(r.body,a,e)},mathmlBuilder(r,e){var t=nr[r.style],a=e.havingStyle(t),i=h0(r.body,a),s=new S.MathNode("mstyle",i),o={display:["0","true"],text:["0","false"],script:["1","false"],scriptscript:["2","false"]},m=o[r.style];return s.setAttribute("scriptlevel",m[0]),s.setAttribute("displaystyle",m[1]),s}});var J1=function(e,t){var a=e.base;if(a)if(a.type==="op"){var i=a.limits&&(t.style.size===I.DISPLAY.size||a.alwaysHandleSupSub);return i?ae:null}else if(a.type==="operatorname"){var s=a.alwaysHandleSupSub&&(t.style.size===I.DISPLAY.size||a.limits);return s?ra:null}else{if(a.type==="accent")return V.isCharacterBox(a.base)?xt:null;if(a.type==="horizBrace"){var o=!e.sub;return o===a.isOver?_r:null}else return null}else return null};W0({type:"supsub",htmlBuilder(r,e){var t=J1(r,e);if(t)return t(r,e);var{base:a,sup:i,sub:s}=r,o=F(a,e),m,c,p=e.fontMetrics(),g=0,y=0,w=a&&V.isCharacterBox(a);if(i){var x=e.havingStyle(e.style.sup());m=F(i,x,e),w||(g=o.height-x.fontMetrics().supDrop*x.sizeMultiplier/e.sizeMultiplier)}if(s){var z=e.havingStyle(e.style.sub());c=F(s,z,e),w||(y=o.depth+z.fontMetrics().subDrop*z.sizeMultiplier/e.sizeMultiplier)}var A;e.style===I.DISPLAY?A=p.sup1:e.style.cramped?A=p.sup3:A=p.sup2;var C=e.sizeMultiplier,q=T(.5/p.ptPerEm/C),E=null;if(c){var O=r.base&&r.base.type==="op"&&r.base.name&&(r.base.name==="\\oiint"||r.base.name==="\\oiiint");(o instanceof p0||O)&&(E=T(-o.italic))}var G;if(m&&c){g=Math.max(g,A,m.depth+.25*p.xHeight),y=Math.max(y,p.sub2);var L=p.defaultRuleThickness,U=4*L;if(g-m.depth-(c.height-y)<U){y=U-(g-m.depth)+c.height;var P=.8*p.xHeight-(g-m.depth);P>0&&(g+=P,y-=P)}var j=[{type:"elem",elem:c,shift:y,marginRight:q,marginLeft:E},{type:"elem",elem:m,shift:-g,marginRight:q}];G=b.makeVList({positionType:"individualShift",children:j},e)}else if(c){y=Math.max(y,p.sub1,c.height-.8*p.xHeight);var Y=[{type:"elem",elem:c,marginLeft:E,marginRight:q}];G=b.makeVList({positionType:"shift",positionData:y,children:Y},e)}else if(m)g=Math.max(g,A,m.depth+.25*p.xHeight),G=b.makeVList({positionType:"shift",positionData:-g,children:[{type:"elem",elem:m,marginRight:q}]},e);else throw new Error("supsub must have either sup or sub.");var z0=ot(o,"right")||"mord";return b.makeSpan([z0],[o,b.makeSpan(["msupsub"],[G])],e)},mathmlBuilder(r,e){var t=!1,a,i;r.base&&r.base.type==="horizBrace"&&(i=!!r.sup,i===r.base.isOver&&(t=!0,a=r.base.isOver)),r.base&&(r.base.type==="op"||r.base.type==="operatorname")&&(r.base.parentIsSupSub=!0);var s=[X(r.base,e)];r.sub&&s.push(X(r.sub,e)),r.sup&&s.push(X(r.sup,e));var o;if(t)o=a?"mover":"munder";else if(r.sub)if(r.sup){var p=r.base;p&&p.type==="op"&&p.limits&&e.style===I.DISPLAY||p&&p.type==="operatorname"&&p.alwaysHandleSupSub&&(e.style===I.DISPLAY||p.limits)?o="munderover":o="msubsup"}else{var c=r.base;c&&c.type==="op"&&c.limits&&(e.style===I.DISPLAY||c.alwaysHandleSupSub)||c&&c.type==="operatorname"&&c.alwaysHandleSupSub&&(c.limits||e.style===I.DISPLAY)?o="munder":o="msub"}else{var m=r.base;m&&m.type==="op"&&m.limits&&(e.style===I.DISPLAY||m.alwaysHandleSupSub)||m&&m.type==="operatorname"&&m.alwaysHandleSupSub&&(m.limits||e.style===I.DISPLAY)?o="mover":o="msup"}return new S.MathNode(o,s)}});W0({type:"atom",htmlBuilder(r,e){return b.mathsym(r.text,r.mode,e,["m"+r.family])},mathmlBuilder(r,e){var t=new S.MathNode("mo",[v0(r.text,r.mode)]);if(r.family==="bin"){var a=yt(r,e);a==="bold-italic"&&t.setAttribute("mathvariant",a)}else r.family==="punct"?t.setAttribute("separator","true"):(r.family==="open"||r.family==="close")&&t.setAttribute("stretchy","false");return t}});var ia={mi:"italic",mn:"normal",mtext:"normal"};W0({type:"mathord",htmlBuilder(r,e){return b.makeOrd(r,e,"mathord")},mathmlBuilder(r,e){var t=new S.MathNode("mi",[v0(r.text,r.mode,e)]),a=yt(r,e)||"italic";return a!==ia[t.type]&&t.setAttribute("mathvariant",a),t}});W0({type:"textord",htmlBuilder(r,e){return b.makeOrd(r,e,"textord")},mathmlBuilder(r,e){var t=v0(r.text,r.mode,e),a=yt(r,e)||"normal",i;return r.mode==="text"?i=new S.MathNode("mtext",[t]):/[0-9]/.test(r.text)?i=new S.MathNode("mn",[t]):r.text==="\\prime"?i=new S.MathNode("mo",[t]):i=new S.MathNode("mi",[t]),a!==ia[i.type]&&i.setAttribute("mathvariant",a),i}});var tt={"\\nobreak":"nobreak","\\allowbreak":"allowbreak"},rt={" ":{},"\\ ":{},"~":{className:"nobreak"},"\\space":{},"\\nobreakspace":{className:"nobreak"}};W0({type:"spacing",htmlBuilder(r,e){if(rt.hasOwnProperty(r.text)){var t=rt[r.text].className||"";if(r.mode==="text"){var a=b.makeOrd(r,e,"textord");return a.classes.push(t),a}else return b.makeSpan(["mspace",t],[b.mathsym(r.text,r.mode,e)],e)}else{if(tt.hasOwnProperty(r.text))return b.makeSpan(["mspace",tt[r.text]],[],e);throw new M('Unknown type of space "'+r.text+'"')}},mathmlBuilder(r,e){var t;if(rt.hasOwnProperty(r.text))t=new S.MathNode("mtext",[new S.TextNode(" ")]);else{if(tt.hasOwnProperty(r.text))return new S.MathNode("mspace");throw new M('Unknown type of space "'+r.text+'"')}return t}});var sr=()=>{var r=new S.MathNode("mtd",[]);return r.setAttribute("width","50%"),r};W0({type:"tag",mathmlBuilder(r,e){var t=new S.MathNode("mtable",[new S.MathNode("mtr",[sr(),new S.MathNode("mtd",[G0(r.body,e)]),sr(),new S.MathNode("mtd",[G0(r.tag,e)])])]);return t.setAttribute("width","100%"),t}});var lr={"\\text":void 0,"\\textrm":"textrm","\\textsf":"textsf","\\texttt":"texttt","\\textnormal":"textrm"},or={"\\textbf":"textbf","\\textmd":"textmd"},Q1={"\\textit":"textit","\\textup":"textup"},hr=(r,e)=>{var t=r.font;if(t){if(lr[t])return e.withTextFontFamily(lr[t]);if(or[t])return e.withTextFontWeight(or[t]);if(t==="\\emph")return e.fontShape==="textit"?e.withTextFontShape("textup"):e.withTextFontShape("textit")}else return e;return e.withTextFontShape(Q1[t])};B({type:"text",names:["\\text","\\textrm","\\textsf","\\texttt","\\textnormal","\\textbf","\\textmd","\\textit","\\textup","\\emph"],props:{numArgs:1,argTypes:["text"],allowedInArgument:!0,allowedInText:!0},handler(r,e){var{parser:t,funcName:a}=r,i=e[0];return{type:"text",mode:t.mode,body:Q(i),font:a}},htmlBuilder(r,e){var t=hr(r,e),a=t0(r.body,t,!0);return b.makeSpan(["mord","text"],a,t)},mathmlBuilder(r,e){var t=hr(r,e);return G0(r.body,t)}});B({type:"underline",names:["\\underline"],props:{numArgs:1,allowedInText:!0},handler(r,e){var{parser:t}=r;return{type:"underline",mode:t.mode,body:e[0]}},htmlBuilder(r,e){var t=F(r.body,e),a=b.makeLineSpan("underline-line",e),i=e.fontMetrics().defaultRuleThickness,s=b.makeVList({positionType:"top",positionData:t.height,children:[{type:"kern",size:i},{type:"elem",elem:a},{type:"kern",size:3*i},{type:"elem",elem:t}]},e);return b.makeSpan(["mord","underline"],[s],e)},mathmlBuilder(r,e){var t=new S.MathNode("mo",[new S.TextNode("‾")]);t.setAttribute("stretchy","true");var a=new S.MathNode("munder",[X(r.body,e),t]);return a.setAttribute("accentunder","true"),a}});B({type:"vcenter",names:["\\vcenter"],props:{numArgs:1,argTypes:["original"],allowedInText:!1},handler(r,e){var{parser:t}=r;return{type:"vcenter",mode:t.mode,body:e[0]}},htmlBuilder(r,e){var t=F(r.body,e),a=e.fontMetrics().axisHeight,i=.5*(t.height-a-(t.depth+a));return b.makeVList({positionType:"shift",positionData:i,children:[{type:"elem",elem:t}]},e)},mathmlBuilder(r,e){return new S.MathNode("mpadded",[X(r.body,e)],["vcenter"])}});B({type:"verb",names:["\\verb"],props:{numArgs:0,allowedInText:!0},handler(r,e,t){throw new M("\\verb ended by end of line instead of matching delimiter")},htmlBuilder(r,e){for(var t=mr(r),a=[],i=e.havingStyle(e.style.text()),s=0;s<t.length;s++){var o=t[s];o==="~"&&(o="\\textasciitilde"),a.push(b.makeSymbol(o,"Typewriter-Regular",r.mode,i,["mord","texttt"]))}return b.makeSpan(["mord","text"].concat(i.sizingClasses(e)),b.tryCombineChars(a),i)},mathmlBuilder(r,e){var t=new S.TextNode(mr(r)),a=new S.MathNode("mtext",[t]);return a.setAttribute("mathvariant","monospace"),a}});var mr=r=>r.body.replace(/ /g,r.star?"␣":" "),F0=Ar,na=`[ \r
	]`,_1="\\\\[a-zA-Z@]+",e4="\\\\[^\uD800-\uDFFF]",t4="("+_1+")"+na+"*",r4=`\\\\(
|[ \r	]+
?)[ \r	]*`,ct="[̀-ͯ]",a4=new RegExp(ct+"+$"),i4="("+na+"+)|"+(r4+"|")+"([!-\\[\\]-‧‪-퟿豈-￿]"+(ct+"*")+"|[\uD800-\uDBFF][\uDC00-\uDFFF]"+(ct+"*")+"|\\\\verb\\*([^]).*?\\4|\\\\verb([^*a-zA-Z]).*?\\5"+("|"+t4)+("|"+e4+")");class ur{constructor(e,t){this.input=void 0,this.settings=void 0,this.tokenRegex=void 0,this.catcodes=void 0,this.input=e,this.settings=t,this.tokenRegex=new RegExp(i4,"g"),this.catcodes={"%":14,"~":13}}setCatcode(e,t){this.catcodes[e]=t}lex(){var e=this.input,t=this.tokenRegex.lastIndex;if(t===e.length)return new u0("EOF",new o0(this,t,t));var a=this.tokenRegex.exec(e);if(a===null||a.index!==t)throw new M("Unexpected character: '"+e[t]+"'",new u0(e[t],new o0(this,t,t+1)));var i=a[6]||a[3]||(a[2]?"\\ ":" ");if(this.catcodes[i]===14){var s=e.indexOf(`
`,this.tokenRegex.lastIndex);return s===-1?(this.tokenRegex.lastIndex=e.length,this.settings.reportNonstrict("commentAtEnd","% comment has no terminating newline; LaTeX would fail because of commenting the end of math mode (e.g. $)")):this.tokenRegex.lastIndex=s+1,this.lex()}return new u0(i,new o0(this,t,this.tokenRegex.lastIndex))}}class n4{constructor(e,t){e===void 0&&(e={}),t===void 0&&(t={}),this.current=void 0,this.builtins=void 0,this.undefStack=void 0,this.current=t,this.builtins=e,this.undefStack=[]}beginGroup(){this.undefStack.push({})}endGroup(){if(this.undefStack.length===0)throw new M("Unbalanced namespace destruction: attempt to pop global namespace; please report this as a bug");var e=this.undefStack.pop();for(var t in e)e.hasOwnProperty(t)&&(e[t]==null?delete this.current[t]:this.current[t]=e[t])}endGroups(){for(;this.undefStack.length>0;)this.endGroup()}has(e){return this.current.hasOwnProperty(e)||this.builtins.hasOwnProperty(e)}get(e){return this.current.hasOwnProperty(e)?this.current[e]:this.builtins[e]}set(e,t,a){if(a===void 0&&(a=!1),a){for(var i=0;i<this.undefStack.length;i++)delete this.undefStack[i][e];this.undefStack.length>0&&(this.undefStack[this.undefStack.length-1][e]=t)}else{var s=this.undefStack[this.undefStack.length-1];s&&!s.hasOwnProperty(e)&&(s[e]=this.current[e])}t==null?delete this.current[e]:this.current[e]=t}}var s4=jr;u("\\noexpand",function(r){var e=r.popToken();return r.isExpandable(e.text)&&(e.noexpand=!0,e.treatAsRelax=!0),{tokens:[e],numArgs:0}});u("\\expandafter",function(r){var e=r.popToken();return r.expandOnce(!0),{tokens:[e],numArgs:0}});u("\\@firstoftwo",function(r){var e=r.consumeArgs(2);return{tokens:e[0],numArgs:0}});u("\\@secondoftwo",function(r){var e=r.consumeArgs(2);return{tokens:e[1],numArgs:0}});u("\\@ifnextchar",function(r){var e=r.consumeArgs(3);r.consumeSpaces();var t=r.future();return e[0].length===1&&e[0][0].text===t.text?{tokens:e[1],numArgs:0}:{tokens:e[2],numArgs:0}});u("\\@ifstar","\\@ifnextchar *{\\@firstoftwo{#1}}");u("\\TextOrMath",function(r){var e=r.consumeArgs(2);return r.mode==="text"?{tokens:e[0],numArgs:0}:{tokens:e[1],numArgs:0}});var cr={0:0,1:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,a:10,A:10,b:11,B:11,c:12,C:12,d:13,D:13,e:14,E:14,f:15,F:15};u("\\char",function(r){var e=r.popToken(),t,a="";if(e.text==="'")t=8,e=r.popToken();else if(e.text==='"')t=16,e=r.popToken();else if(e.text==="`")if(e=r.popToken(),e.text[0]==="\\")a=e.text.charCodeAt(1);else{if(e.text==="EOF")throw new M("\\char` missing argument");a=e.text.charCodeAt(0)}else t=10;if(t){if(a=cr[e.text],a==null||a>=t)throw new M("Invalid base-"+t+" digit "+e.text);for(var i;(i=cr[r.future().text])!=null&&i<t;)a*=t,a+=i,r.popToken()}return"\\@char{"+a+"}"});var Nt=(r,e,t,a)=>{var i=r.consumeArg().tokens;if(i.length!==1)throw new M("\\newcommand's first argument must be a macro name");var s=i[0].text,o=r.isDefined(s);if(o&&!e)throw new M("\\newcommand{"+s+"} attempting to redefine "+(s+"; use \\renewcommand"));if(!o&&!t)throw new M("\\renewcommand{"+s+"} when command "+s+" does not yet exist; use \\newcommand");var m=0;if(i=r.consumeArg().tokens,i.length===1&&i[0].text==="["){for(var c="",p=r.expandNextToken();p.text!=="]"&&p.text!=="EOF";)c+=p.text,p=r.expandNextToken();if(!c.match(/^\s*[0-9]+\s*$/))throw new M("Invalid number of arguments: "+c);m=parseInt(c),i=r.consumeArg().tokens}return o&&a||r.macros.set(s,{tokens:i,numArgs:m}),""};u("\\newcommand",r=>Nt(r,!1,!0,!1));u("\\renewcommand",r=>Nt(r,!0,!1,!1));u("\\providecommand",r=>Nt(r,!0,!0,!0));u("\\message",r=>{var e=r.consumeArgs(1)[0];return console.log(e.reverse().map(t=>t.text).join("")),""});u("\\errmessage",r=>{var e=r.consumeArgs(1)[0];return console.error(e.reverse().map(t=>t.text).join("")),""});u("\\show",r=>{var e=r.popToken(),t=e.text;return console.log(e,r.macros.get(t),F0[t],$.math[t],$.text[t]),""});u("\\bgroup","{");u("\\egroup","}");u("~","\\nobreakspace");u("\\lq","`");u("\\rq","'");u("\\aa","\\r a");u("\\AA","\\r A");u("\\textcopyright","\\html@mathml{\\textcircled{c}}{\\char`©}");u("\\copyright","\\TextOrMath{\\textcopyright}{\\text{\\textcopyright}}");u("\\textregistered","\\html@mathml{\\textcircled{\\scriptsize R}}{\\char`®}");u("ℬ","\\mathscr{B}");u("ℰ","\\mathscr{E}");u("ℱ","\\mathscr{F}");u("ℋ","\\mathscr{H}");u("ℐ","\\mathscr{I}");u("ℒ","\\mathscr{L}");u("ℳ","\\mathscr{M}");u("ℛ","\\mathscr{R}");u("ℭ","\\mathfrak{C}");u("ℌ","\\mathfrak{H}");u("ℨ","\\mathfrak{Z}");u("\\Bbbk","\\Bbb{k}");u("·","\\cdotp");u("\\llap","\\mathllap{\\textrm{#1}}");u("\\rlap","\\mathrlap{\\textrm{#1}}");u("\\clap","\\mathclap{\\textrm{#1}}");u("\\mathstrut","\\vphantom{(}");u("\\underbar","\\underline{\\text{#1}}");u("\\not",'\\html@mathml{\\mathrel{\\mathrlap\\@not}}{\\char"338}');u("\\neq","\\html@mathml{\\mathrel{\\not=}}{\\mathrel{\\char`≠}}");u("\\ne","\\neq");u("≠","\\neq");u("\\notin","\\html@mathml{\\mathrel{{\\in}\\mathllap{/\\mskip1mu}}}{\\mathrel{\\char`∉}}");u("∉","\\notin");u("≘","\\html@mathml{\\mathrel{=\\kern{-1em}\\raisebox{0.4em}{$\\scriptsize\\frown$}}}{\\mathrel{\\char`≘}}");u("≙","\\html@mathml{\\stackrel{\\tiny\\wedge}{=}}{\\mathrel{\\char`≘}}");u("≚","\\html@mathml{\\stackrel{\\tiny\\vee}{=}}{\\mathrel{\\char`≚}}");u("≛","\\html@mathml{\\stackrel{\\scriptsize\\star}{=}}{\\mathrel{\\char`≛}}");u("≝","\\html@mathml{\\stackrel{\\tiny\\mathrm{def}}{=}}{\\mathrel{\\char`≝}}");u("≞","\\html@mathml{\\stackrel{\\tiny\\mathrm{m}}{=}}{\\mathrel{\\char`≞}}");u("≟","\\html@mathml{\\stackrel{\\tiny?}{=}}{\\mathrel{\\char`≟}}");u("⟂","\\perp");u("‼","\\mathclose{!\\mkern-0.8mu!}");u("∌","\\notni");u("⌜","\\ulcorner");u("⌝","\\urcorner");u("⌞","\\llcorner");u("⌟","\\lrcorner");u("©","\\copyright");u("®","\\textregistered");u("️","\\textregistered");u("\\ulcorner",'\\html@mathml{\\@ulcorner}{\\mathop{\\char"231c}}');u("\\urcorner",'\\html@mathml{\\@urcorner}{\\mathop{\\char"231d}}');u("\\llcorner",'\\html@mathml{\\@llcorner}{\\mathop{\\char"231e}}');u("\\lrcorner",'\\html@mathml{\\@lrcorner}{\\mathop{\\char"231f}}');u("\\vdots","{\\varvdots\\rule{0pt}{15pt}}");u("⋮","\\vdots");u("\\varGamma","\\mathit{\\Gamma}");u("\\varDelta","\\mathit{\\Delta}");u("\\varTheta","\\mathit{\\Theta}");u("\\varLambda","\\mathit{\\Lambda}");u("\\varXi","\\mathit{\\Xi}");u("\\varPi","\\mathit{\\Pi}");u("\\varSigma","\\mathit{\\Sigma}");u("\\varUpsilon","\\mathit{\\Upsilon}");u("\\varPhi","\\mathit{\\Phi}");u("\\varPsi","\\mathit{\\Psi}");u("\\varOmega","\\mathit{\\Omega}");u("\\substack","\\begin{subarray}{c}#1\\end{subarray}");u("\\colon","\\nobreak\\mskip2mu\\mathpunct{}\\mathchoice{\\mkern-3mu}{\\mkern-3mu}{}{}{:}\\mskip6mu\\relax");u("\\boxed","\\fbox{$\\displaystyle{#1}$}");u("\\iff","\\DOTSB\\;\\Longleftrightarrow\\;");u("\\implies","\\DOTSB\\;\\Longrightarrow\\;");u("\\impliedby","\\DOTSB\\;\\Longleftarrow\\;");u("\\dddot","{\\overset{\\raisebox{-0.1ex}{\\normalsize ...}}{#1}}");u("\\ddddot","{\\overset{\\raisebox{-0.1ex}{\\normalsize ....}}{#1}}");var dr={",":"\\dotsc","\\not":"\\dotsb","+":"\\dotsb","=":"\\dotsb","<":"\\dotsb",">":"\\dotsb","-":"\\dotsb","*":"\\dotsb",":":"\\dotsb","\\DOTSB":"\\dotsb","\\coprod":"\\dotsb","\\bigvee":"\\dotsb","\\bigwedge":"\\dotsb","\\biguplus":"\\dotsb","\\bigcap":"\\dotsb","\\bigcup":"\\dotsb","\\prod":"\\dotsb","\\sum":"\\dotsb","\\bigotimes":"\\dotsb","\\bigoplus":"\\dotsb","\\bigodot":"\\dotsb","\\bigsqcup":"\\dotsb","\\And":"\\dotsb","\\longrightarrow":"\\dotsb","\\Longrightarrow":"\\dotsb","\\longleftarrow":"\\dotsb","\\Longleftarrow":"\\dotsb","\\longleftrightarrow":"\\dotsb","\\Longleftrightarrow":"\\dotsb","\\mapsto":"\\dotsb","\\longmapsto":"\\dotsb","\\hookrightarrow":"\\dotsb","\\doteq":"\\dotsb","\\mathbin":"\\dotsb","\\mathrel":"\\dotsb","\\relbar":"\\dotsb","\\Relbar":"\\dotsb","\\xrightarrow":"\\dotsb","\\xleftarrow":"\\dotsb","\\DOTSI":"\\dotsi","\\int":"\\dotsi","\\oint":"\\dotsi","\\iint":"\\dotsi","\\iiint":"\\dotsi","\\iiiint":"\\dotsi","\\idotsint":"\\dotsi","\\DOTSX":"\\dotsx"};u("\\dots",function(r){var e="\\dotso",t=r.expandAfterFuture().text;return t in dr?e=dr[t]:(t.slice(0,4)==="\\not"||t in $.math&&["bin","rel"].includes($.math[t].group))&&(e="\\dotsb"),e});var Ct={")":!0,"]":!0,"\\rbrack":!0,"\\}":!0,"\\rbrace":!0,"\\rangle":!0,"\\rceil":!0,"\\rfloor":!0,"\\rgroup":!0,"\\rmoustache":!0,"\\right":!0,"\\bigr":!0,"\\biggr":!0,"\\Bigr":!0,"\\Biggr":!0,$:!0,";":!0,".":!0,",":!0};u("\\dotso",function(r){var e=r.future().text;return e in Ct?"\\ldots\\,":"\\ldots"});u("\\dotsc",function(r){var e=r.future().text;return e in Ct&&e!==","?"\\ldots\\,":"\\ldots"});u("\\cdots",function(r){var e=r.future().text;return e in Ct?"\\@cdots\\,":"\\@cdots"});u("\\dotsb","\\cdots");u("\\dotsm","\\cdots");u("\\dotsi","\\!\\cdots");u("\\dotsx","\\ldots\\,");u("\\DOTSI","\\relax");u("\\DOTSB","\\relax");u("\\DOTSX","\\relax");u("\\tmspace","\\TextOrMath{\\kern#1#3}{\\mskip#1#2}\\relax");u("\\,","\\tmspace+{3mu}{.1667em}");u("\\thinspace","\\,");u("\\>","\\mskip{4mu}");u("\\:","\\tmspace+{4mu}{.2222em}");u("\\medspace","\\:");u("\\;","\\tmspace+{5mu}{.2777em}");u("\\thickspace","\\;");u("\\!","\\tmspace-{3mu}{.1667em}");u("\\negthinspace","\\!");u("\\negmedspace","\\tmspace-{4mu}{.2222em}");u("\\negthickspace","\\tmspace-{5mu}{.277em}");u("\\enspace","\\kern.5em ");u("\\enskip","\\hskip.5em\\relax");u("\\quad","\\hskip1em\\relax");u("\\qquad","\\hskip2em\\relax");u("\\tag","\\@ifstar\\tag@literal\\tag@paren");u("\\tag@paren","\\tag@literal{({#1})}");u("\\tag@literal",r=>{if(r.macros.get("\\df@tag"))throw new M("Multiple \\tag");return"\\gdef\\df@tag{\\text{#1}}"});u("\\bmod","\\mathchoice{\\mskip1mu}{\\mskip1mu}{\\mskip5mu}{\\mskip5mu}\\mathbin{\\rm mod}\\mathchoice{\\mskip1mu}{\\mskip1mu}{\\mskip5mu}{\\mskip5mu}");u("\\pod","\\allowbreak\\mathchoice{\\mkern18mu}{\\mkern8mu}{\\mkern8mu}{\\mkern8mu}(#1)");u("\\pmod","\\pod{{\\rm mod}\\mkern6mu#1}");u("\\mod","\\allowbreak\\mathchoice{\\mkern18mu}{\\mkern12mu}{\\mkern12mu}{\\mkern12mu}{\\rm mod}\\,\\,#1");u("\\newline","\\\\\\relax");u("\\TeX","\\textrm{\\html@mathml{T\\kern-.1667em\\raisebox{-.5ex}{E}\\kern-.125emX}{TeX}}");var sa=T(w0["Main-Regular"][84][1]-.7*w0["Main-Regular"][65][1]);u("\\LaTeX","\\textrm{\\html@mathml{"+("L\\kern-.36em\\raisebox{"+sa+"}{\\scriptstyle A}")+"\\kern-.15em\\TeX}{LaTeX}}");u("\\KaTeX","\\textrm{\\html@mathml{"+("K\\kern-.17em\\raisebox{"+sa+"}{\\scriptstyle A}")+"\\kern-.15em\\TeX}{KaTeX}}");u("\\hspace","\\@ifstar\\@hspacer\\@hspace");u("\\@hspace","\\hskip #1\\relax");u("\\@hspacer","\\rule{0pt}{0pt}\\hskip #1\\relax");u("\\ordinarycolon",":");u("\\vcentcolon","\\mathrel{\\mathop\\ordinarycolon}");u("\\dblcolon",'\\html@mathml{\\mathrel{\\vcentcolon\\mathrel{\\mkern-.9mu}\\vcentcolon}}{\\mathop{\\char"2237}}');u("\\coloneqq",'\\html@mathml{\\mathrel{\\vcentcolon\\mathrel{\\mkern-1.2mu}=}}{\\mathop{\\char"2254}}');u("\\Coloneqq",'\\html@mathml{\\mathrel{\\dblcolon\\mathrel{\\mkern-1.2mu}=}}{\\mathop{\\char"2237\\char"3d}}');u("\\coloneq",'\\html@mathml{\\mathrel{\\vcentcolon\\mathrel{\\mkern-1.2mu}\\mathrel{-}}}{\\mathop{\\char"3a\\char"2212}}');u("\\Coloneq",'\\html@mathml{\\mathrel{\\dblcolon\\mathrel{\\mkern-1.2mu}\\mathrel{-}}}{\\mathop{\\char"2237\\char"2212}}');u("\\eqqcolon",'\\html@mathml{\\mathrel{=\\mathrel{\\mkern-1.2mu}\\vcentcolon}}{\\mathop{\\char"2255}}');u("\\Eqqcolon",'\\html@mathml{\\mathrel{=\\mathrel{\\mkern-1.2mu}\\dblcolon}}{\\mathop{\\char"3d\\char"2237}}');u("\\eqcolon",'\\html@mathml{\\mathrel{\\mathrel{-}\\mathrel{\\mkern-1.2mu}\\vcentcolon}}{\\mathop{\\char"2239}}');u("\\Eqcolon",'\\html@mathml{\\mathrel{\\mathrel{-}\\mathrel{\\mkern-1.2mu}\\dblcolon}}{\\mathop{\\char"2212\\char"2237}}');u("\\colonapprox",'\\html@mathml{\\mathrel{\\vcentcolon\\mathrel{\\mkern-1.2mu}\\approx}}{\\mathop{\\char"3a\\char"2248}}');u("\\Colonapprox",'\\html@mathml{\\mathrel{\\dblcolon\\mathrel{\\mkern-1.2mu}\\approx}}{\\mathop{\\char"2237\\char"2248}}');u("\\colonsim",'\\html@mathml{\\mathrel{\\vcentcolon\\mathrel{\\mkern-1.2mu}\\sim}}{\\mathop{\\char"3a\\char"223c}}');u("\\Colonsim",'\\html@mathml{\\mathrel{\\dblcolon\\mathrel{\\mkern-1.2mu}\\sim}}{\\mathop{\\char"2237\\char"223c}}');u("∷","\\dblcolon");u("∹","\\eqcolon");u("≔","\\coloneqq");u("≕","\\eqqcolon");u("⩴","\\Coloneqq");u("\\ratio","\\vcentcolon");u("\\coloncolon","\\dblcolon");u("\\colonequals","\\coloneqq");u("\\coloncolonequals","\\Coloneqq");u("\\equalscolon","\\eqqcolon");u("\\equalscoloncolon","\\Eqqcolon");u("\\colonminus","\\coloneq");u("\\coloncolonminus","\\Coloneq");u("\\minuscolon","\\eqcolon");u("\\minuscoloncolon","\\Eqcolon");u("\\coloncolonapprox","\\Colonapprox");u("\\coloncolonsim","\\Colonsim");u("\\simcolon","\\mathrel{\\sim\\mathrel{\\mkern-1.2mu}\\vcentcolon}");u("\\simcoloncolon","\\mathrel{\\sim\\mathrel{\\mkern-1.2mu}\\dblcolon}");u("\\approxcolon","\\mathrel{\\approx\\mathrel{\\mkern-1.2mu}\\vcentcolon}");u("\\approxcoloncolon","\\mathrel{\\approx\\mathrel{\\mkern-1.2mu}\\dblcolon}");u("\\notni","\\html@mathml{\\not\\ni}{\\mathrel{\\char`∌}}");u("\\limsup","\\DOTSB\\operatorname*{lim\\,sup}");u("\\liminf","\\DOTSB\\operatorname*{lim\\,inf}");u("\\injlim","\\DOTSB\\operatorname*{inj\\,lim}");u("\\projlim","\\DOTSB\\operatorname*{proj\\,lim}");u("\\varlimsup","\\DOTSB\\operatorname*{\\overline{lim}}");u("\\varliminf","\\DOTSB\\operatorname*{\\underline{lim}}");u("\\varinjlim","\\DOTSB\\operatorname*{\\underrightarrow{lim}}");u("\\varprojlim","\\DOTSB\\operatorname*{\\underleftarrow{lim}}");u("\\gvertneqq","\\html@mathml{\\@gvertneqq}{≩}");u("\\lvertneqq","\\html@mathml{\\@lvertneqq}{≨}");u("\\ngeqq","\\html@mathml{\\@ngeqq}{≱}");u("\\ngeqslant","\\html@mathml{\\@ngeqslant}{≱}");u("\\nleqq","\\html@mathml{\\@nleqq}{≰}");u("\\nleqslant","\\html@mathml{\\@nleqslant}{≰}");u("\\nshortmid","\\html@mathml{\\@nshortmid}{∤}");u("\\nshortparallel","\\html@mathml{\\@nshortparallel}{∦}");u("\\nsubseteqq","\\html@mathml{\\@nsubseteqq}{⊈}");u("\\nsupseteqq","\\html@mathml{\\@nsupseteqq}{⊉}");u("\\varsubsetneq","\\html@mathml{\\@varsubsetneq}{⊊}");u("\\varsubsetneqq","\\html@mathml{\\@varsubsetneqq}{⫋}");u("\\varsupsetneq","\\html@mathml{\\@varsupsetneq}{⊋}");u("\\varsupsetneqq","\\html@mathml{\\@varsupsetneqq}{⫌}");u("\\imath","\\html@mathml{\\@imath}{ı}");u("\\jmath","\\html@mathml{\\@jmath}{ȷ}");u("\\llbracket","\\html@mathml{\\mathopen{[\\mkern-3.2mu[}}{\\mathopen{\\char`⟦}}");u("\\rrbracket","\\html@mathml{\\mathclose{]\\mkern-3.2mu]}}{\\mathclose{\\char`⟧}}");u("⟦","\\llbracket");u("⟧","\\rrbracket");u("\\lBrace","\\html@mathml{\\mathopen{\\{\\mkern-3.2mu[}}{\\mathopen{\\char`⦃}}");u("\\rBrace","\\html@mathml{\\mathclose{]\\mkern-3.2mu\\}}}{\\mathclose{\\char`⦄}}");u("⦃","\\lBrace");u("⦄","\\rBrace");u("\\minuso","\\mathbin{\\html@mathml{{\\mathrlap{\\mathchoice{\\kern{0.145em}}{\\kern{0.145em}}{\\kern{0.1015em}}{\\kern{0.0725em}}\\circ}{-}}}{\\char`⦵}}");u("⦵","\\minuso");u("\\darr","\\downarrow");u("\\dArr","\\Downarrow");u("\\Darr","\\Downarrow");u("\\lang","\\langle");u("\\rang","\\rangle");u("\\uarr","\\uparrow");u("\\uArr","\\Uparrow");u("\\Uarr","\\Uparrow");u("\\N","\\mathbb{N}");u("\\R","\\mathbb{R}");u("\\Z","\\mathbb{Z}");u("\\alef","\\aleph");u("\\alefsym","\\aleph");u("\\Alpha","\\mathrm{A}");u("\\Beta","\\mathrm{B}");u("\\bull","\\bullet");u("\\Chi","\\mathrm{X}");u("\\clubs","\\clubsuit");u("\\cnums","\\mathbb{C}");u("\\Complex","\\mathbb{C}");u("\\Dagger","\\ddagger");u("\\diamonds","\\diamondsuit");u("\\empty","\\emptyset");u("\\Epsilon","\\mathrm{E}");u("\\Eta","\\mathrm{H}");u("\\exist","\\exists");u("\\harr","\\leftrightarrow");u("\\hArr","\\Leftrightarrow");u("\\Harr","\\Leftrightarrow");u("\\hearts","\\heartsuit");u("\\image","\\Im");u("\\infin","\\infty");u("\\Iota","\\mathrm{I}");u("\\isin","\\in");u("\\Kappa","\\mathrm{K}");u("\\larr","\\leftarrow");u("\\lArr","\\Leftarrow");u("\\Larr","\\Leftarrow");u("\\lrarr","\\leftrightarrow");u("\\lrArr","\\Leftrightarrow");u("\\Lrarr","\\Leftrightarrow");u("\\Mu","\\mathrm{M}");u("\\natnums","\\mathbb{N}");u("\\Nu","\\mathrm{N}");u("\\Omicron","\\mathrm{O}");u("\\plusmn","\\pm");u("\\rarr","\\rightarrow");u("\\rArr","\\Rightarrow");u("\\Rarr","\\Rightarrow");u("\\real","\\Re");u("\\reals","\\mathbb{R}");u("\\Reals","\\mathbb{R}");u("\\Rho","\\mathrm{P}");u("\\sdot","\\cdot");u("\\sect","\\S");u("\\spades","\\spadesuit");u("\\sub","\\subset");u("\\sube","\\subseteq");u("\\supe","\\supseteq");u("\\Tau","\\mathrm{T}");u("\\thetasym","\\vartheta");u("\\weierp","\\wp");u("\\Zeta","\\mathrm{Z}");u("\\argmin","\\DOTSB\\operatorname*{arg\\,min}");u("\\argmax","\\DOTSB\\operatorname*{arg\\,max}");u("\\plim","\\DOTSB\\mathop{\\operatorname{plim}}\\limits");u("\\bra","\\mathinner{\\langle{#1}|}");u("\\ket","\\mathinner{|{#1}\\rangle}");u("\\braket","\\mathinner{\\langle{#1}\\rangle}");u("\\Bra","\\left\\langle#1\\right|");u("\\Ket","\\left|#1\\right\\rangle");var la=r=>e=>{var t=e.consumeArg().tokens,a=e.consumeArg().tokens,i=e.consumeArg().tokens,s=e.consumeArg().tokens,o=e.macros.get("|"),m=e.macros.get("\\|");e.macros.beginGroup();var c=y=>w=>{r&&(w.macros.set("|",o),i.length&&w.macros.set("\\|",m));var x=y;if(!y&&i.length){var z=w.future();z.text==="|"&&(w.popToken(),x=!0)}return{tokens:x?i:a,numArgs:0}};e.macros.set("|",c(!1)),i.length&&e.macros.set("\\|",c(!0));var p=e.consumeArg().tokens,g=e.expandTokens([...s,...p,...t]);return e.macros.endGroup(),{tokens:g.reverse(),numArgs:0}};u("\\bra@ket",la(!1));u("\\bra@set",la(!0));u("\\Braket","\\bra@ket{\\left\\langle}{\\,\\middle\\vert\\,}{\\,\\middle\\vert\\,}{\\right\\rangle}");u("\\Set","\\bra@set{\\left\\{\\:}{\\;\\middle\\vert\\;}{\\;\\middle\\Vert\\;}{\\:\\right\\}}");u("\\set","\\bra@set{\\{\\,}{\\mid}{}{\\,\\}}");u("\\angln","{\\angl n}");u("\\blue","\\textcolor{##6495ed}{#1}");u("\\orange","\\textcolor{##ffa500}{#1}");u("\\pink","\\textcolor{##ff00af}{#1}");u("\\red","\\textcolor{##df0030}{#1}");u("\\green","\\textcolor{##28ae7b}{#1}");u("\\gray","\\textcolor{gray}{#1}");u("\\purple","\\textcolor{##9d38bd}{#1}");u("\\blueA","\\textcolor{##ccfaff}{#1}");u("\\blueB","\\textcolor{##80f6ff}{#1}");u("\\blueC","\\textcolor{##63d9ea}{#1}");u("\\blueD","\\textcolor{##11accd}{#1}");u("\\blueE","\\textcolor{##0c7f99}{#1}");u("\\tealA","\\textcolor{##94fff5}{#1}");u("\\tealB","\\textcolor{##26edd5}{#1}");u("\\tealC","\\textcolor{##01d1c1}{#1}");u("\\tealD","\\textcolor{##01a995}{#1}");u("\\tealE","\\textcolor{##208170}{#1}");u("\\greenA","\\textcolor{##b6ffb0}{#1}");u("\\greenB","\\textcolor{##8af281}{#1}");u("\\greenC","\\textcolor{##74cf70}{#1}");u("\\greenD","\\textcolor{##1fab54}{#1}");u("\\greenE","\\textcolor{##0d923f}{#1}");u("\\goldA","\\textcolor{##ffd0a9}{#1}");u("\\goldB","\\textcolor{##ffbb71}{#1}");u("\\goldC","\\textcolor{##ff9c39}{#1}");u("\\goldD","\\textcolor{##e07d10}{#1}");u("\\goldE","\\textcolor{##a75a05}{#1}");u("\\redA","\\textcolor{##fca9a9}{#1}");u("\\redB","\\textcolor{##ff8482}{#1}");u("\\redC","\\textcolor{##f9685d}{#1}");u("\\redD","\\textcolor{##e84d39}{#1}");u("\\redE","\\textcolor{##bc2612}{#1}");u("\\maroonA","\\textcolor{##ffbde0}{#1}");u("\\maroonB","\\textcolor{##ff92c6}{#1}");u("\\maroonC","\\textcolor{##ed5fa6}{#1}");u("\\maroonD","\\textcolor{##ca337c}{#1}");u("\\maroonE","\\textcolor{##9e034e}{#1}");u("\\purpleA","\\textcolor{##ddd7ff}{#1}");u("\\purpleB","\\textcolor{##c6b9fc}{#1}");u("\\purpleC","\\textcolor{##aa87ff}{#1}");u("\\purpleD","\\textcolor{##7854ab}{#1}");u("\\purpleE","\\textcolor{##543b78}{#1}");u("\\mintA","\\textcolor{##f5f9e8}{#1}");u("\\mintB","\\textcolor{##edf2df}{#1}");u("\\mintC","\\textcolor{##e0e5cc}{#1}");u("\\grayA","\\textcolor{##f6f7f7}{#1}");u("\\grayB","\\textcolor{##f0f1f2}{#1}");u("\\grayC","\\textcolor{##e3e5e6}{#1}");u("\\grayD","\\textcolor{##d6d8da}{#1}");u("\\grayE","\\textcolor{##babec2}{#1}");u("\\grayF","\\textcolor{##888d93}{#1}");u("\\grayG","\\textcolor{##626569}{#1}");u("\\grayH","\\textcolor{##3b3e40}{#1}");u("\\grayI","\\textcolor{##21242c}{#1}");u("\\kaBlue","\\textcolor{##314453}{#1}");u("\\kaGreen","\\textcolor{##71B307}{#1}");var oa={"^":!0,_:!0,"\\limits":!0,"\\nolimits":!0};class l4{constructor(e,t,a){this.settings=void 0,this.expansionCount=void 0,this.lexer=void 0,this.macros=void 0,this.stack=void 0,this.mode=void 0,this.settings=t,this.expansionCount=0,this.feed(e),this.macros=new n4(s4,t.macros),this.mode=a,this.stack=[]}feed(e){this.lexer=new ur(e,this.settings)}switchMode(e){this.mode=e}beginGroup(){this.macros.beginGroup()}endGroup(){this.macros.endGroup()}endGroups(){this.macros.endGroups()}future(){return this.stack.length===0&&this.pushToken(this.lexer.lex()),this.stack[this.stack.length-1]}popToken(){return this.future(),this.stack.pop()}pushToken(e){this.stack.push(e)}pushTokens(e){this.stack.push(...e)}scanArgument(e){var t,a,i;if(e){if(this.consumeSpaces(),this.future().text!=="[")return null;t=this.popToken(),{tokens:i,end:a}=this.consumeArg(["]"])}else({tokens:i,start:t,end:a}=this.consumeArg());return this.pushToken(new u0("EOF",a.loc)),this.pushTokens(i),new u0("",o0.range(t,a))}consumeSpaces(){for(;;){var e=this.future();if(e.text===" ")this.stack.pop();else break}}consumeArg(e){var t=[],a=e&&e.length>0;a||this.consumeSpaces();var i=this.future(),s,o=0,m=0;do{if(s=this.popToken(),t.push(s),s.text==="{")++o;else if(s.text==="}"){if(--o,o===-1)throw new M("Extra }",s)}else if(s.text==="EOF")throw new M("Unexpected end of input in a macro argument, expected '"+(e&&a?e[m]:"}")+"'",s);if(e&&a)if((o===0||o===1&&e[m]==="{")&&s.text===e[m]){if(++m,m===e.length){t.splice(-m,m);break}}else m=0}while(o!==0||a);return i.text==="{"&&t[t.length-1].text==="}"&&(t.pop(),t.shift()),t.reverse(),{tokens:t,start:i,end:s}}consumeArgs(e,t){if(t){if(t.length!==e+1)throw new M("The length of delimiters doesn't match the number of args!");for(var a=t[0],i=0;i<a.length;i++){var s=this.popToken();if(a[i]!==s.text)throw new M("Use of the macro doesn't match its definition",s)}}for(var o=[],m=0;m<e;m++)o.push(this.consumeArg(t&&t[m+1]).tokens);return o}countExpansion(e){if(this.expansionCount+=e,this.expansionCount>this.settings.maxExpand)throw new M("Too many expansions: infinite loop or need to increase maxExpand setting")}expandOnce(e){var t=this.popToken(),a=t.text,i=t.noexpand?null:this._getExpansion(a);if(i==null||e&&i.unexpandable){if(e&&i==null&&a[0]==="\\"&&!this.isDefined(a))throw new M("Undefined control sequence: "+a);return this.pushToken(t),!1}this.countExpansion(1);var s=i.tokens,o=this.consumeArgs(i.numArgs,i.delimiters);if(i.numArgs){s=s.slice();for(var m=s.length-1;m>=0;--m){var c=s[m];if(c.text==="#"){if(m===0)throw new M("Incomplete placeholder at end of macro body",c);if(c=s[--m],c.text==="#")s.splice(m+1,1);else if(/^[1-9]$/.test(c.text))s.splice(m,2,...o[+c.text-1]);else throw new M("Not a valid argument number",c)}}}return this.pushTokens(s),s.length}expandAfterFuture(){return this.expandOnce(),this.future()}expandNextToken(){for(;;)if(this.expandOnce()===!1){var e=this.stack.pop();return e.treatAsRelax&&(e.text="\\relax"),e}throw new Error}expandMacro(e){return this.macros.has(e)?this.expandTokens([new u0(e)]):void 0}expandTokens(e){var t=[],a=this.stack.length;for(this.pushTokens(e);this.stack.length>a;)if(this.expandOnce(!0)===!1){var i=this.stack.pop();i.treatAsRelax&&(i.noexpand=!1,i.treatAsRelax=!1),t.push(i)}return this.countExpansion(t.length),t}expandMacroAsText(e){var t=this.expandMacro(e);return t&&t.map(a=>a.text).join("")}_getExpansion(e){var t=this.macros.get(e);if(t==null)return t;if(e.length===1){var a=this.lexer.catcodes[e];if(a!=null&&a!==13)return}var i=typeof t=="function"?t(this):t;if(typeof i=="string"){var s=0;if(i.indexOf("#")!==-1)for(var o=i.replace(/##/g,"");o.indexOf("#"+(s+1))!==-1;)++s;for(var m=new ur(i,this.settings),c=[],p=m.lex();p.text!=="EOF";)c.push(p),p=m.lex();c.reverse();var g={tokens:c,numArgs:s};return g}return i}isDefined(e){return this.macros.has(e)||F0.hasOwnProperty(e)||$.math.hasOwnProperty(e)||$.text.hasOwnProperty(e)||oa.hasOwnProperty(e)}isExpandable(e){var t=this.macros.get(e);return t!=null?typeof t=="string"||typeof t=="function"||!t.unexpandable:F0.hasOwnProperty(e)&&!F0[e].primitive}}var fr=/^[₊₋₌₍₎₀₁₂₃₄₅₆₇₈₉ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓᵦᵧᵨᵩᵪ]/,Me=Object.freeze({"₊":"+","₋":"-","₌":"=","₍":"(","₎":")","₀":"0","₁":"1","₂":"2","₃":"3","₄":"4","₅":"5","₆":"6","₇":"7","₈":"8","₉":"9","ₐ":"a","ₑ":"e","ₕ":"h","ᵢ":"i","ⱼ":"j","ₖ":"k","ₗ":"l","ₘ":"m","ₙ":"n","ₒ":"o","ₚ":"p","ᵣ":"r","ₛ":"s","ₜ":"t","ᵤ":"u","ᵥ":"v","ₓ":"x","ᵦ":"β","ᵧ":"γ","ᵨ":"ρ","ᵩ":"ϕ","ᵪ":"χ","⁺":"+","⁻":"-","⁼":"=","⁽":"(","⁾":")","⁰":"0","¹":"1","²":"2","³":"3","⁴":"4","⁵":"5","⁶":"6","⁷":"7","⁸":"8","⁹":"9","ᴬ":"A","ᴮ":"B","ᴰ":"D","ᴱ":"E","ᴳ":"G","ᴴ":"H","ᴵ":"I","ᴶ":"J","ᴷ":"K","ᴸ":"L","ᴹ":"M","ᴺ":"N","ᴼ":"O","ᴾ":"P","ᴿ":"R","ᵀ":"T","ᵁ":"U","ⱽ":"V","ᵂ":"W","ᵃ":"a","ᵇ":"b","ᶜ":"c","ᵈ":"d","ᵉ":"e","ᶠ":"f","ᵍ":"g",ʰ:"h","ⁱ":"i",ʲ:"j","ᵏ":"k",ˡ:"l","ᵐ":"m",ⁿ:"n","ᵒ":"o","ᵖ":"p",ʳ:"r",ˢ:"s","ᵗ":"t","ᵘ":"u","ᵛ":"v",ʷ:"w",ˣ:"x",ʸ:"y","ᶻ":"z","ᵝ":"β","ᵞ":"γ","ᵟ":"δ","ᵠ":"ϕ","ᵡ":"χ","ᶿ":"θ"}),at={"́":{text:"\\'",math:"\\acute"},"̀":{text:"\\`",math:"\\grave"},"̈":{text:'\\"',math:"\\ddot"},"̃":{text:"\\~",math:"\\tilde"},"̄":{text:"\\=",math:"\\bar"},"̆":{text:"\\u",math:"\\breve"},"̌":{text:"\\v",math:"\\check"},"̂":{text:"\\^",math:"\\hat"},"̇":{text:"\\.",math:"\\dot"},"̊":{text:"\\r",math:"\\mathring"},"̋":{text:"\\H"},"̧":{text:"\\c"}},pr={á:"á",à:"à",ä:"ä",ǟ:"ǟ",ã:"ã",ā:"ā",ă:"ă",ắ:"ắ",ằ:"ằ",ẵ:"ẵ",ǎ:"ǎ",â:"â",ấ:"ấ",ầ:"ầ",ẫ:"ẫ",ȧ:"ȧ",ǡ:"ǡ",å:"å",ǻ:"ǻ",ḃ:"ḃ",ć:"ć",ḉ:"ḉ",č:"č",ĉ:"ĉ",ċ:"ċ",ç:"ç",ď:"ď",ḋ:"ḋ",ḑ:"ḑ",é:"é",è:"è",ë:"ë",ẽ:"ẽ",ē:"ē",ḗ:"ḗ",ḕ:"ḕ",ĕ:"ĕ",ḝ:"ḝ",ě:"ě",ê:"ê",ế:"ế",ề:"ề",ễ:"ễ",ė:"ė",ȩ:"ȩ",ḟ:"ḟ",ǵ:"ǵ",ḡ:"ḡ",ğ:"ğ",ǧ:"ǧ",ĝ:"ĝ",ġ:"ġ",ģ:"ģ",ḧ:"ḧ",ȟ:"ȟ",ĥ:"ĥ",ḣ:"ḣ",ḩ:"ḩ",í:"í",ì:"ì",ï:"ï",ḯ:"ḯ",ĩ:"ĩ",ī:"ī",ĭ:"ĭ",ǐ:"ǐ",î:"î",ǰ:"ǰ",ĵ:"ĵ",ḱ:"ḱ",ǩ:"ǩ",ķ:"ķ",ĺ:"ĺ",ľ:"ľ",ļ:"ļ",ḿ:"ḿ",ṁ:"ṁ",ń:"ń",ǹ:"ǹ",ñ:"ñ",ň:"ň",ṅ:"ṅ",ņ:"ņ",ó:"ó",ò:"ò",ö:"ö",ȫ:"ȫ",õ:"õ",ṍ:"ṍ",ṏ:"ṏ",ȭ:"ȭ",ō:"ō",ṓ:"ṓ",ṑ:"ṑ",ŏ:"ŏ",ǒ:"ǒ",ô:"ô",ố:"ố",ồ:"ồ",ỗ:"ỗ",ȯ:"ȯ",ȱ:"ȱ",ő:"ő",ṕ:"ṕ",ṗ:"ṗ",ŕ:"ŕ",ř:"ř",ṙ:"ṙ",ŗ:"ŗ",ś:"ś",ṥ:"ṥ",š:"š",ṧ:"ṧ",ŝ:"ŝ",ṡ:"ṡ",ş:"ş",ẗ:"ẗ",ť:"ť",ṫ:"ṫ",ţ:"ţ",ú:"ú",ù:"ù",ü:"ü",ǘ:"ǘ",ǜ:"ǜ",ǖ:"ǖ",ǚ:"ǚ",ũ:"ũ",ṹ:"ṹ",ū:"ū",ṻ:"ṻ",ŭ:"ŭ",ǔ:"ǔ",û:"û",ů:"ů",ű:"ű",ṽ:"ṽ",ẃ:"ẃ",ẁ:"ẁ",ẅ:"ẅ",ŵ:"ŵ",ẇ:"ẇ",ẘ:"ẘ",ẍ:"ẍ",ẋ:"ẋ",ý:"ý",ỳ:"ỳ",ÿ:"ÿ",ỹ:"ỹ",ȳ:"ȳ",ŷ:"ŷ",ẏ:"ẏ",ẙ:"ẙ",ź:"ź",ž:"ž",ẑ:"ẑ",ż:"ż",Á:"Á",À:"À",Ä:"Ä",Ǟ:"Ǟ",Ã:"Ã",Ā:"Ā",Ă:"Ă",Ắ:"Ắ",Ằ:"Ằ",Ẵ:"Ẵ",Ǎ:"Ǎ",Â:"Â",Ấ:"Ấ",Ầ:"Ầ",Ẫ:"Ẫ",Ȧ:"Ȧ",Ǡ:"Ǡ",Å:"Å",Ǻ:"Ǻ",Ḃ:"Ḃ",Ć:"Ć",Ḉ:"Ḉ",Č:"Č",Ĉ:"Ĉ",Ċ:"Ċ",Ç:"Ç",Ď:"Ď",Ḋ:"Ḋ",Ḑ:"Ḑ",É:"É",È:"È",Ë:"Ë",Ẽ:"Ẽ",Ē:"Ē",Ḗ:"Ḗ",Ḕ:"Ḕ",Ĕ:"Ĕ",Ḝ:"Ḝ",Ě:"Ě",Ê:"Ê",Ế:"Ế",Ề:"Ề",Ễ:"Ễ",Ė:"Ė",Ȩ:"Ȩ",Ḟ:"Ḟ",Ǵ:"Ǵ",Ḡ:"Ḡ",Ğ:"Ğ",Ǧ:"Ǧ",Ĝ:"Ĝ",Ġ:"Ġ",Ģ:"Ģ",Ḧ:"Ḧ",Ȟ:"Ȟ",Ĥ:"Ĥ",Ḣ:"Ḣ",Ḩ:"Ḩ",Í:"Í",Ì:"Ì",Ï:"Ï",Ḯ:"Ḯ",Ĩ:"Ĩ",Ī:"Ī",Ĭ:"Ĭ",Ǐ:"Ǐ",Î:"Î",İ:"İ",Ĵ:"Ĵ",Ḱ:"Ḱ",Ǩ:"Ǩ",Ķ:"Ķ",Ĺ:"Ĺ",Ľ:"Ľ",Ļ:"Ļ",Ḿ:"Ḿ",Ṁ:"Ṁ",Ń:"Ń",Ǹ:"Ǹ",Ñ:"Ñ",Ň:"Ň",Ṅ:"Ṅ",Ņ:"Ņ",Ó:"Ó",Ò:"Ò",Ö:"Ö",Ȫ:"Ȫ",Õ:"Õ",Ṍ:"Ṍ",Ṏ:"Ṏ",Ȭ:"Ȭ",Ō:"Ō",Ṓ:"Ṓ",Ṑ:"Ṑ",Ŏ:"Ŏ",Ǒ:"Ǒ",Ô:"Ô",Ố:"Ố",Ồ:"Ồ",Ỗ:"Ỗ",Ȯ:"Ȯ",Ȱ:"Ȱ",Ő:"Ő",Ṕ:"Ṕ",Ṗ:"Ṗ",Ŕ:"Ŕ",Ř:"Ř",Ṙ:"Ṙ",Ŗ:"Ŗ",Ś:"Ś",Ṥ:"Ṥ",Š:"Š",Ṧ:"Ṧ",Ŝ:"Ŝ",Ṡ:"Ṡ",Ş:"Ş",Ť:"Ť",Ṫ:"Ṫ",Ţ:"Ţ",Ú:"Ú",Ù:"Ù",Ü:"Ü",Ǘ:"Ǘ",Ǜ:"Ǜ",Ǖ:"Ǖ",Ǚ:"Ǚ",Ũ:"Ũ",Ṹ:"Ṹ",Ū:"Ū",Ṻ:"Ṻ",Ŭ:"Ŭ",Ǔ:"Ǔ",Û:"Û",Ů:"Ů",Ű:"Ű",Ṽ:"Ṽ",Ẃ:"Ẃ",Ẁ:"Ẁ",Ẅ:"Ẅ",Ŵ:"Ŵ",Ẇ:"Ẇ",Ẍ:"Ẍ",Ẋ:"Ẋ",Ý:"Ý",Ỳ:"Ỳ",Ÿ:"Ÿ",Ỹ:"Ỹ",Ȳ:"Ȳ",Ŷ:"Ŷ",Ẏ:"Ẏ",Ź:"Ź",Ž:"Ž",Ẑ:"Ẑ",Ż:"Ż",ά:"ά",ὰ:"ὰ",ᾱ:"ᾱ",ᾰ:"ᾰ",έ:"έ",ὲ:"ὲ",ή:"ή",ὴ:"ὴ",ί:"ί",ὶ:"ὶ",ϊ:"ϊ",ΐ:"ΐ",ῒ:"ῒ",ῑ:"ῑ",ῐ:"ῐ",ό:"ό",ὸ:"ὸ",ύ:"ύ",ὺ:"ὺ",ϋ:"ϋ",ΰ:"ΰ",ῢ:"ῢ",ῡ:"ῡ",ῠ:"ῠ",ώ:"ώ",ὼ:"ὼ",Ύ:"Ύ",Ὺ:"Ὺ",Ϋ:"Ϋ",Ῡ:"Ῡ",Ῠ:"Ῠ",Ώ:"Ώ",Ὼ:"Ὼ"};class Le{constructor(e,t){this.mode=void 0,this.gullet=void 0,this.settings=void 0,this.leftrightDepth=void 0,this.nextToken=void 0,this.mode="math",this.gullet=new l4(e,t,this.mode),this.settings=t,this.leftrightDepth=0}expect(e,t){if(t===void 0&&(t=!0),this.fetch().text!==e)throw new M("Expected '"+e+"', got '"+this.fetch().text+"'",this.fetch());t&&this.consume()}consume(){this.nextToken=null}fetch(){return this.nextToken==null&&(this.nextToken=this.gullet.expandNextToken()),this.nextToken}switchMode(e){this.mode=e,this.gullet.switchMode(e)}parse(){this.settings.globalGroup||this.gullet.beginGroup(),this.settings.colorIsTextColor&&this.gullet.macros.set("\\color","\\textcolor");try{var e=this.parseExpression(!1);return this.expect("EOF"),this.settings.globalGroup||this.gullet.endGroup(),e}finally{this.gullet.endGroups()}}subparse(e){var t=this.nextToken;this.consume(),this.gullet.pushToken(new u0("}")),this.gullet.pushTokens(e);var a=this.parseExpression(!1);return this.expect("}"),this.nextToken=t,a}parseExpression(e,t){for(var a=[];;){this.mode==="math"&&this.consumeSpaces();var i=this.fetch();if(Le.endOfExpression.indexOf(i.text)!==-1||t&&i.text===t||e&&F0[i.text]&&F0[i.text].infix)break;var s=this.parseAtom(t);if(s){if(s.type==="internal")continue}else break;a.push(s)}return this.mode==="text"&&this.formLigatures(a),this.handleInfixNodes(a)}handleInfixNodes(e){for(var t=-1,a,i=0;i<e.length;i++)if(e[i].type==="infix"){if(t!==-1)throw new M("only one infix operator per group",e[i].token);t=i,a=e[i].replaceWith}if(t!==-1&&a){var s,o,m=e.slice(0,t),c=e.slice(t+1);m.length===1&&m[0].type==="ordgroup"?s=m[0]:s={type:"ordgroup",mode:this.mode,body:m},c.length===1&&c[0].type==="ordgroup"?o=c[0]:o={type:"ordgroup",mode:this.mode,body:c};var p;return a==="\\\\abovefrac"?p=this.callFunction(a,[s,e[t],o],[]):p=this.callFunction(a,[s,o],[]),[p]}else return e}handleSupSubscript(e){var t=this.fetch(),a=t.text;this.consume(),this.consumeSpaces();var i;do{var s;i=this.parseGroup(e)}while(((s=i)==null?void 0:s.type)==="internal");if(!i)throw new M("Expected group after '"+a+"'",t);return i}formatUnsupportedCmd(e){for(var t=[],a=0;a<e.length;a++)t.push({type:"textord",mode:"text",text:e[a]});var i={type:"text",mode:this.mode,body:t},s={type:"color",mode:this.mode,color:this.settings.errorColor,body:[i]};return s}parseAtom(e){var t=this.parseGroup("atom",e);if(t?.type==="internal"||this.mode==="text")return t;for(var a,i;;){this.consumeSpaces();var s=this.fetch();if(s.text==="\\limits"||s.text==="\\nolimits"){if(t&&t.type==="op"){var o=s.text==="\\limits";t.limits=o,t.alwaysHandleSupSub=!0}else if(t&&t.type==="operatorname")t.alwaysHandleSupSub&&(t.limits=s.text==="\\limits");else throw new M("Limit controls must follow a math operator",s);this.consume()}else if(s.text==="^"){if(a)throw new M("Double superscript",s);a=this.handleSupSubscript("superscript")}else if(s.text==="_"){if(i)throw new M("Double subscript",s);i=this.handleSupSubscript("subscript")}else if(s.text==="'"){if(a)throw new M("Double superscript",s);var m={type:"textord",mode:this.mode,text:"\\prime"},c=[m];for(this.consume();this.fetch().text==="'";)c.push(m),this.consume();this.fetch().text==="^"&&c.push(this.handleSupSubscript("superscript")),a={type:"ordgroup",mode:this.mode,body:c}}else if(Me[s.text]){var p=fr.test(s.text),g=[];for(g.push(new u0(Me[s.text])),this.consume();;){var y=this.fetch().text;if(!Me[y]||fr.test(y)!==p)break;g.unshift(new u0(Me[y])),this.consume()}var w=this.subparse(g);p?i={type:"ordgroup",mode:"math",body:w}:a={type:"ordgroup",mode:"math",body:w}}else break}return a||i?{type:"supsub",mode:this.mode,base:t,sup:a,sub:i}:t}parseFunction(e,t){var a=this.fetch(),i=a.text,s=F0[i];if(!s)return null;if(this.consume(),t&&t!=="atom"&&!s.allowedInArgument)throw new M("Got function '"+i+"' with no arguments"+(t?" as "+t:""),a);if(this.mode==="text"&&!s.allowedInText)throw new M("Can't use function '"+i+"' in text mode",a);if(this.mode==="math"&&s.allowedInMath===!1)throw new M("Can't use function '"+i+"' in math mode",a);var{args:o,optArgs:m}=this.parseArguments(i,s);return this.callFunction(i,o,m,a,e)}callFunction(e,t,a,i,s){var o={funcName:e,parser:this,token:i,breakOnTokenText:s},m=F0[e];if(m&&m.handler)return m.handler(o,t,a);throw new M("No function handler for "+e)}parseArguments(e,t){var a=t.numArgs+t.numOptionalArgs;if(a===0)return{args:[],optArgs:[]};for(var i=[],s=[],o=0;o<a;o++){var m=t.argTypes&&t.argTypes[o],c=o<t.numOptionalArgs;(t.primitive&&m==null||t.type==="sqrt"&&o===1&&s[0]==null)&&(m="primitive");var p=this.parseGroupOfType("argument to '"+e+"'",m,c);if(c)s.push(p);else if(p!=null)i.push(p);else throw new M("Null argument, please report this as a bug")}return{args:i,optArgs:s}}parseGroupOfType(e,t,a){switch(t){case"color":return this.parseColorGroup(a);case"size":return this.parseSizeGroup(a);case"url":return this.parseUrlGroup(a);case"math":case"text":return this.parseArgumentGroup(a,t);case"hbox":{var i=this.parseArgumentGroup(a,"text");return i!=null?{type:"styling",mode:i.mode,body:[i],style:"text"}:null}case"raw":{var s=this.parseStringGroup("raw",a);return s!=null?{type:"raw",mode:"text",string:s.text}:null}case"primitive":{if(a)throw new M("A primitive argument cannot be optional");var o=this.parseGroup(e);if(o==null)throw new M("Expected group as "+e,this.fetch());return o}case"original":case null:case void 0:return this.parseArgumentGroup(a);default:throw new M("Unknown group type as "+e,this.fetch())}}consumeSpaces(){for(;this.fetch().text===" ";)this.consume()}parseStringGroup(e,t){var a=this.gullet.scanArgument(t);if(a==null)return null;for(var i="",s;(s=this.fetch()).text!=="EOF";)i+=s.text,this.consume();return this.consume(),a.text=i,a}parseRegexGroup(e,t){for(var a=this.fetch(),i=a,s="",o;(o=this.fetch()).text!=="EOF"&&e.test(s+o.text);)i=o,s+=i.text,this.consume();if(s==="")throw new M("Invalid "+t+": '"+a.text+"'",a);return a.range(i,s)}parseColorGroup(e){var t=this.parseStringGroup("color",e);if(t==null)return null;var a=/^(#[a-f0-9]{3,4}|#[a-f0-9]{6}|#[a-f0-9]{8}|[a-f0-9]{6}|[a-z]+)$/i.exec(t.text);if(!a)throw new M("Invalid color: '"+t.text+"'",t);var i=a[0];return/^[0-9a-f]{6}$/i.test(i)&&(i="#"+i),{type:"color-token",mode:this.mode,color:i}}parseSizeGroup(e){var t,a=!1;if(this.gullet.consumeSpaces(),!e&&this.gullet.future().text!=="{"?t=this.parseRegexGroup(/^[-+]? *(?:$|\d+|\d+\.\d*|\.\d*) *[a-z]{0,2} *$/,"size"):t=this.parseStringGroup("size",e),!t)return null;!e&&t.text.length===0&&(t.text="0pt",a=!0);var i=/([-+]?) *(\d+(?:\.\d*)?|\.\d+) *([a-z]{2})/.exec(t.text);if(!i)throw new M("Invalid size: '"+t.text+"'",t);var s={number:+(i[1]+i[2]),unit:i[3]};if(!br(s))throw new M("Invalid unit: '"+s.unit+"'",t);return{type:"size",mode:this.mode,value:s,isBlank:a}}parseUrlGroup(e){this.gullet.lexer.setCatcode("%",13),this.gullet.lexer.setCatcode("~",12);var t=this.parseStringGroup("url",e);if(this.gullet.lexer.setCatcode("%",14),this.gullet.lexer.setCatcode("~",13),t==null)return null;var a=t.text.replace(/\\([#$%&~_^{}])/g,"$1");return{type:"url",mode:this.mode,url:a}}parseArgumentGroup(e,t){var a=this.gullet.scanArgument(e);if(a==null)return null;var i=this.mode;t&&this.switchMode(t),this.gullet.beginGroup();var s=this.parseExpression(!1,"EOF");this.expect("EOF"),this.gullet.endGroup();var o={type:"ordgroup",mode:this.mode,loc:a.loc,body:s};return t&&this.switchMode(i),o}parseGroup(e,t){var a=this.fetch(),i=a.text,s;if(i==="{"||i==="\\begingroup"){this.consume();var o=i==="{"?"}":"\\endgroup";this.gullet.beginGroup();var m=this.parseExpression(!1,o),c=this.fetch();this.expect(o),this.gullet.endGroup(),s={type:"ordgroup",mode:this.mode,loc:o0.range(a,c),body:m,semisimple:i==="\\begingroup"||void 0}}else if(s=this.parseFunction(t,e)||this.parseSymbol(),s==null&&i[0]==="\\"&&!oa.hasOwnProperty(i)){if(this.settings.throwOnError)throw new M("Undefined control sequence: "+i,a);s=this.formatUnsupportedCmd(i),this.consume()}return s}formLigatures(e){for(var t=e.length-1,a=0;a<t;++a){var i=e[a],s=i.text;s==="-"&&e[a+1].text==="-"&&(a+1<t&&e[a+2].text==="-"?(e.splice(a,3,{type:"textord",mode:"text",loc:o0.range(i,e[a+2]),text:"---"}),t-=2):(e.splice(a,2,{type:"textord",mode:"text",loc:o0.range(i,e[a+1]),text:"--"}),t-=1)),(s==="'"||s==="`")&&e[a+1].text===s&&(e.splice(a,2,{type:"textord",mode:"text",loc:o0.range(i,e[a+1]),text:s+s}),t-=1)}}parseSymbol(){var e=this.fetch(),t=e.text;if(/^\\verb[^a-zA-Z]/.test(t)){this.consume();var a=t.slice(5),i=a.charAt(0)==="*";if(i&&(a=a.slice(1)),a.length<2||a.charAt(0)!==a.slice(-1))throw new M(`\\verb assertion failed --
                    please report what input caused this bug`);return a=a.slice(1,-1),{type:"verb",mode:"text",body:a,star:i}}pr.hasOwnProperty(t[0])&&!$[this.mode][t[0]]&&(this.settings.strict&&this.mode==="math"&&this.settings.reportNonstrict("unicodeTextInMathMode",'Accented Unicode text character "'+t[0]+'" used in math mode',e),t=pr[t[0]]+t.slice(1));var s=a4.exec(t);s&&(t=t.substring(0,s.index),t==="i"?t="ı":t==="j"&&(t="ȷ"));var o;if($[this.mode][t]){this.settings.strict&&this.mode==="math"&&lt.indexOf(t)>=0&&this.settings.reportNonstrict("unicodeTextInMathMode",'Latin-1/Unicode text character "'+t[0]+'" used in math mode',e);var m=$[this.mode][t].group,c=o0.range(e),p;if(Za.hasOwnProperty(m)){var g=m;p={type:"atom",mode:this.mode,family:g,loc:c,text:t}}else p={type:m,mode:this.mode,loc:c,text:t};o=p}else if(t.charCodeAt(0)>=128)this.settings.strict&&(gr(t.charCodeAt(0))?this.mode==="math"&&this.settings.reportNonstrict("unicodeTextInMathMode",'Unicode text character "'+t[0]+'" used in math mode',e):this.settings.reportNonstrict("unknownSymbol",'Unrecognized Unicode character "'+t[0]+'"'+(" ("+t.charCodeAt(0)+")"),e)),o={type:"textord",mode:"text",loc:o0.range(e),text:t};else return null;if(this.consume(),s)for(var y=0;y<s[0].length;y++){var w=s[0][y];if(!at[w])throw new M("Unknown accent ' "+w+"'",e);var x=at[w][this.mode]||at[w].text;if(!x)throw new M("Accent "+w+" unsupported in "+this.mode+" mode",e);o={type:"accent",mode:this.mode,loc:o0.range(e),label:x,isStretchy:!1,isShifty:!0,base:o}}return o}}Le.endOfExpression=["}","\\endgroup","\\end","\\right","&"];var qt=function(e,t){if(!(typeof e=="string"||e instanceof String))throw new TypeError("KaTeX can only parse string typed expression");var a=new Le(e,t);delete a.gullet.macros.current["\\df@tag"];var i=a.parse();if(delete a.gullet.macros.current["\\current@color"],delete a.gullet.macros.current["\\color"],a.gullet.macros.get("\\df@tag")){if(!t.displayMode)throw new M("\\tag works only in display equations");i=[{type:"tag",mode:"text",body:i,tag:a.subparse([new u0("\\df@tag")])}]}return i},ha=function(e,t,a){t.textContent="";var i=Rt(e,a).toNode();t.appendChild(i)};typeof document<"u"&&document.compatMode!=="CSS1Compat"&&(typeof console<"u"&&console.warn("Warning: KaTeX doesn't work in quirks mode. Make sure your website has a suitable doctype."),ha=function(){throw new M("KaTeX doesn't work in quirks mode.")});var o4=function(e,t){var a=Rt(e,t).toMarkup();return a},h4=function(e,t){var a=new dt(t);return qt(e,a)},ma=function(e,t,a){if(a.throwOnError||!(e instanceof M))throw e;var i=b.makeSpan(["katex-error"],[new p0(t)]);return i.setAttribute("title",e.toString()),i.setAttribute("style","color:"+a.errorColor),i},Rt=function(e,t){var a=new dt(t);try{var i=qt(e,a);return b1(i,e,a)}catch(s){return ma(s,e,a)}},m4=function(e,t){var a=new dt(t);try{var i=qt(e,a);return y1(i,e,a)}catch(s){return ma(s,e,a)}},u4="0.16.27",c4={Span:me,Anchor:vt,SymbolNode:p0,SvgNode:C0,PathNode:V0,LineNode:st},d4={version:u4,render:ha,renderToString:o4,ParseError:M,SETTINGS_SCHEMA:ze,__parse:h4,__renderToDomTree:Rt,__renderToHTMLTree:m4,__setFontMetrics:Va,__defineSymbol:n,__defineFunction:B,__defineMacro:u,__domTree:c4};return d4;})();
  /* AI_CHAT_FLOW_KATEX_0_16_27_END */

  const V295 = (() => {
    const INTERNAL_CONTENT_TYPES = new Set([
      'thoughts','reasoning_recap','model_editable_context','execution_output',
      'tether_browsing_display','computer_initialize_state','computer_output',
    ]);
    const USER_VISIBLE_CONTENT_TYPES = new Set(['text','multimodal_text','code']);
    
    function cleanSegment(value, fallback = '未命名对话') {
      const cleaned = String(value || fallback)
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/[\x00-\x1f\x80-\x9f]/g, '_')
        .replace(/[. ]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return (cleaned || fallback).slice(0,120);
    }
    function shortId(id){ const value=String(id||''); return value.slice(-6)||'unknown'; }
    function joinPath(...parts){ return parts.flatMap(x=>String(x||'').split('/')).filter(Boolean).join('/'); }
    function sanitizeProjectName(value){ return cleanSegment(value,'未命名项目'); }
    
    function normalizeProject(raw = {}) {
      const nested = raw?.gizmo?.gizmo || raw?.gizmo || raw;
      const id = String(nested?.id || raw?.id || '');
      if (!id) return null;
      const type = String(nested?.gizmo_type || nested?.type || '');
      if (type && type !== 'snorlax' && !id.startsWith('g-p-')) return null;
      return {
        id,
        name:String(nested?.display?.name || nested?.name || raw?.name || '未命名项目'),
        description:String(nested?.display?.description || nested?.description || raw?.description || ''),
        workspace_id:nested?.workspace_id || raw?.workspace_id || null,
        project_id:id,
        gizmo_id:id,
      };
    }
    async function fetchProjects({fetchImpl=globalThis.fetch, headers={}, maxPages=200}={}){
      const items=[]; const seen=new Set(); let cursor=null;
      for(let page=0; page<Math.max(1,Number(maxPages)||200); page+=1){
        const query = new URLSearchParams({owned_only:'true',conversations_per_gizmo:'0'});
        if(cursor) query.set('cursor',cursor);
        const endpoint=`/backend-api/gizmos/snorlax/sidebar?${query}`;
        const response=await fetchImpl(endpoint,{credentials:'include',cache:'no-store',headers});
        if(!response.ok) throw new Error(`project_inventory_fetch_failed:${response.status}`);
        const data=await response.json();
        for(const raw of Array.isArray(data?.items)?data.items:[]){
          const project=normalizeProject(raw); if(!project||seen.has(project.id)) continue;
          seen.add(project.id); items.push(project);
        }
        const next=data?.cursor?String(data.cursor):null;
        if(!next) return {items,completeness:'complete',scope:'projects',cursor_pages:page+1};
        if(next===cursor) throw new Error('project_inventory_cursor_stalled');
        cursor=next;
      }
      throw new Error('project_inventory_page_limit');
    }
    async function fetchProjectConversations(projectId,{fetchImpl=globalThis.fetch,headers={},maxPages=500}={}){
      const id=String(projectId||''); if(!id) throw new Error('project_id_missing');
      const items=[]; const seen=new Set(); let cursor='0';
      for(let page=0;page<Math.max(1,Number(maxPages)||500);page+=1){
        const endpoint=`/backend-api/gizmos/${encodeURIComponent(id)}/conversations?${new URLSearchParams({cursor})}`;
        const response=await fetchImpl(endpoint,{credentials:'include',cache:'no-store',headers});
        if(!response.ok) throw new Error(`project_conversations_fetch_failed:${response.status}`);
        const data=await response.json();
        for(const raw of Array.isArray(data?.items)?data.items:[]){
          const conversationId=String(raw?.id||raw?.conversation_id||''); if(!conversationId||seen.has(conversationId)) continue;
          seen.add(conversationId);
          items.push({...raw,id:conversationId,title:raw?.title||'未命名对话',project_id:id,projectId:id,gizmo_id:String(raw?.gizmo_id||id),source_state:raw?.is_archived===true||raw?.archived===true?'archived':'active'});
        }
        const next=data?.cursor?String(data.cursor):null;
        if(!next) return {items,completeness:'complete',scope:'project',project_id:id,cursor_pages:page+1};
        if(next===cursor) throw new Error('project_conversations_cursor_stalled');
        cursor=next;
      }
      throw new Error('project_conversations_page_limit');
    }
    async function collectProjectInventorySafe({fetchImpl=globalThis.fetch,headers={}}={}){
      try{
        const projects=await fetchProjects({fetchImpl,headers}); const rows=[]; const warnings=[];
        for(const project of projects.items){
          try{ const conversations=await fetchProjectConversations(project.id,{fetchImpl,headers}); rows.push({project,items:conversations.items}); }
          catch(error){ warnings.push(`${project.name}：${error.message}`); }
        }
        return {rows,supported:true,warning:warnings.length?`部分 Project 读取失败：${warnings.join('；')}`:''};
      }catch(error){ return {rows:[],supported:false,warning:`Project 读取失败，已继续普通对话同步：${error.message}`}; }
    }
    function mergeInventoryWithProjects(ordinary=[],projectRows=[]){
      const byId=new Map();
      for(const item of ordinary||[]){
        const id=String(item?.id||item?.conversation_id||''); if(!id) continue;
        byId.set(id,{...item,id,project_memberships:Array.isArray(item?.project_memberships)?[...item.project_memberships]:[]});
      }
      for(const row of projectRows||[]){
        const project={id:String(row?.project?.id||''),name:String(row?.project?.name||'未命名项目')};
        for(const item of row?.items||[]){
          const id=String(item?.id||item?.conversation_id||''); if(!id) continue;
          const previous=byId.get(id)||{id};
          const memberships=[...(previous.project_memberships||[])];
          if(project.id&&!memberships.some(x=>String(x?.id||'')===project.id)) memberships.push(project);
          byId.set(id,{...previous,...item,id,project_id:project.id||item?.project_id||null,project_name:project.name,project_memberships:memberships});
        }
      }
      return {items:[...byId.values()]};
    }
    
    function classificationFolder(classification={}){
      if(classification?.folder) return String(classification.folder).split('/').filter(Boolean).map(x=>cleanSegment(x)).join('/');
      if(classification?.kind==='未归类'||!classification?.kind) return '未归类';
      const name=classification?.name?cleanSegment(classification.name):'';
      return name?joinPath(cleanSegment(classification.kind),name):cleanSegment(classification.kind);
    }
    function planPersistentViews(item={}){
      const conversationId=String(item?.conversation_id||item?.id||'');
      const title=item?.title||'未命名对话';
      const stemTitle=item?.classification?.file_title||title;
      const stem=`${cleanSegment(stemTitle)}__${shortId(conversationId)}`;
      const folder=classificationFolder(item?.classification||{});
      const specs=[['raw',RAW_ROOT,'.json'],['json',JSON_ROOT,'.json'],['markdown',MARKDOWN_ROOT,'.md'],['pdf',PDF_ROOT,'.pdf']];
      const result=[];
      for(const [kind,root,ext] of specs) result.push({kind,view:'classification',path:joinPath(root,folder,`${stem}${ext}`)});
      const seen=new Set();
      for(const project of item?.project_memberships||[]){
        const projectName=sanitizeProjectName(project?.name||'未命名项目');
        const key=String(project?.id||projectName); if(seen.has(key)) continue; seen.add(key);
        for(const [kind,root,ext] of specs) result.push({kind,view:'project',project_id:project?.id||null,project_name:projectName,path:joinPath(PROJECT_ROOT,projectName,root,`${stem}${ext}`)});
      }
      return result;
    }
    
    function isHidden(message){ return message?.metadata?.is_visually_hidden_from_conversation===true; }
    function recipientOf(message){ return message?.recipient||message?.metadata?.recipient||'all'; }
    function channelOf(message){ return message?.channel||message?.metadata?.channel||null; }
    function contentTypeOf(message){ return message?.content?.content_type||message?.content?.type||'unknown'; }
    function isVisibleChatMessage(message){
      const role=message?.author?.role;
      if(!['user','assistant'].includes(role)||isHidden(message)) return false;
      const contentType=contentTypeOf(message);
      if(INTERNAL_CONTENT_TYPES.has(contentType)||!USER_VISIBLE_CONTENT_TYPES.has(contentType)) return false;
      if(role==='user') return ['text','multimodal_text'].includes(contentType);
      const recipient=recipientOf(message); if(recipient&&recipient!=='all') return false;
      const channel=channelOf(message); if(channel&&!['final','commentary'].includes(channel)) return false;
      return true;
    }
    function textFromPart(part){
      if(typeof part==='string') return part;
      if(!part||typeof part!=='object') return '';
      for(const key of ['text','caption','transcript','result','output','value']) if(typeof part[key]==='string') return part[key];
      return '';
    }
    function messageText(message){
      if(typeof message?.content?.text==='string') return message.content.text;
      const parts=Array.isArray(message?.content?.parts)?message.content.parts:[];
      return parts.map(textFromPart).filter(Boolean).join('\n');
    }
    function cleanConversation(raw={}){
      const messages=Object.values(raw?.mapping||{})
        .map(node=>node?.message).filter(isVisibleChatMessage)
        .sort((a,b)=>Number(a?.create_time||0)-Number(b?.create_time||0))
        .map(message=>({role:message.author.role,text:messageText(message),created_at:message.create_time??null,files:Array.isArray(message?.metadata?.attachments)?message.metadata.attachments:[]}))
        .filter(message=>message.text!==''||message.files.length);
      return {schema_version:'2.9.5-clean-1',conversation_id:String(raw?.id||raw?.conversation_id||''),title:String(raw?.title||'未命名对话'),create_time:raw?.create_time??null,update_time:raw?.update_time??null,messages};
    }
    function renderCleanMarkdown(conversation={}){
      const lines=[`# ${String(conversation?.title||'未命名对话')}`,''];
      for(const message of conversation?.messages||[]){
        if(!['user','assistant'].includes(message?.role)) continue;
        const text=String(message?.text||''); if(!text&&!message?.files?.length) continue;
        lines.push(message.role==='user'?'## 👤 用户':'## 🤖 AI 助手','');
        if(text) lines.push(text,'');
        if(message?.files?.length){
          lines.push(`附件：${message.files.map(file=>file?.name||file?.filename||file?.id||file?.file_id||'未知附件').join('、')}`,'');
        }
        lines.push('---','');
      }
      while(lines.at(-1)==='') lines.pop();
      if(lines.at(-1)==='---') lines.pop();
      return `${lines.join('\n').trimEnd()}\n`;
    }
    
    function parseInlineMarkdown2983(text){
      const source=String(text||'');
      const tokens=[]; let i=0, buffer='';
      const flush=()=>{if(buffer){tokens.push({type:'text',text:buffer});buffer='';}};
      const findClosing=(needle,from)=>{let pos=from;while(pos<source.length){pos=source.indexOf(needle,pos);if(pos<0)return-1;if(source[pos-1]!=="\\")return pos;pos+=needle.length;}return-1;};
      const styled=(segments,style)=>segments.map((segment)=>segment.type==='text'?{...segment,...style}:segment);
      while(i<source.length){
        if(source.startsWith('\\(',i)){
          const end=source.indexOf('\\)',i+2);if(end>=0){flush();tokens.push({type:'math',display:false,latex:source.slice(i+2,end)});i=end+2;continue;}
        }
        if(source[i]==='\\'&&i+1<source.length&&'\\`*_[]$()'.includes(source[i+1])){buffer+=source[i+1];i+=2;continue;}
        if(source[i]==='$'&&source[i+1]!=='$'){
          let end=i+1;while(end<source.length){if(source[end]==='$'&&source[end-1]!=='\\')break;end++;}
          if(end<source.length){flush();tokens.push({type:'math',display:false,latex:source.slice(i+1,end)});i=end+1;continue;}
        }
        if(source[i]==='`'){
          const end=findClosing('`',i+1);if(end>i){flush();tokens.push({type:'text',text:source.slice(i+1,end).split('\\`').join('`'),code:true});i=end+1;continue;}
        }
        if(source[i]==='['){
          const closeLabel=findClosing(']',i+1);
          if(closeLabel>i&&source[closeLabel+1]==='('){const closeUrl=findClosing(')',closeLabel+2);if(closeUrl>closeLabel){flush();tokens.push({type:'text',text:source.slice(i+1,closeLabel),link:source.slice(closeLabel+2,closeUrl)});i=closeUrl+1;continue;}}
        }
        const strongDelim=source.startsWith('**',i)?'**':source.startsWith('__',i)?'__':null;
        if(strongDelim){const end=findClosing(strongDelim,i+2);if(end>i+1){flush();tokens.push(...styled(parseInlineMarkdown2983(source.slice(i+2,end)),{bold:true}));i=end+2;continue;}}
        const italicDelim=(source[i]==='*'||source[i]==='_')?source[i]:null;
        if(italicDelim){const end=findClosing(italicDelim,i+1);if(end>i+1){flush();tokens.push(...styled(parseInlineMarkdown2983(source.slice(i+1,end)),{italic:true}));i=end+1;continue;}}
        buffer+=source[i++];
      }
      flush();return tokens;
    }
    function splitInlineMath(text){ return parseInlineMarkdown2983(text); }
    function tokenizeMarkdown(markdown){
      const lines=String(markdown||'').replace(/\r\n/g,'\n').split('\n');
      const tokens=[]; let i=0;
      while(i<lines.length){
        const line=lines[i];
        if(/^```/.test(line)){
          const lang=line.slice(3).trim(); const body=[]; i++;
          while(i<lines.length&&!/^```/.test(lines[i])) body.push(lines[i++]);
          if(i<lines.length) i++;
          tokens.push({type:'code',language:lang,text:body.join('\n')}); continue;
        }
        if(/^\s*\$\$\s*$/.test(line)){
          const body=[]; i++;
          while(i<lines.length&&!/^\s*\$\$\s*$/.test(lines[i])) body.push(lines[i++]);
          if(i<lines.length) i++;
          tokens.push({type:'math',display:true,latex:body.join('\n')}); continue;
        }
        if(line.includes('$$')){
          const first=line.indexOf('$$'), second=line.indexOf('$$',first+2);
          if(first>=0&&second>first){
            const before=line.slice(0,first); if(before) tokens.push({type:'paragraph',segments:parseInlineMarkdown2983(before)});
            tokens.push({type:'math',display:true,latex:line.slice(first+2,second)});
            const after=line.slice(second+2); if(after) tokens.push({type:'paragraph',segments:parseInlineMarkdown2983(after)});
            i++; continue;
          }
        }
        if(/^\s*\\\[\s*$/.test(line)){
          const body=[]; i++;
          while(i<lines.length&&!/^\s*\\\]\s*$/.test(lines[i])) body.push(lines[i++]);
          if(i<lines.length) i++;
          tokens.push({type:'math',display:true,latex:body.join('\n')}); continue;
        }
        const bracket=line.match(/^(.*)\\\[(.+)\\\](.*)$/);
        if(bracket){
          if(bracket[1]) tokens.push({type:'paragraph',segments:parseInlineMarkdown2983(bracket[1])});
          tokens.push({type:'math',display:true,latex:bracket[2]});
          if(bracket[3]) tokens.push({type:'paragraph',segments:parseInlineMarkdown2983(bracket[3])});
          i++; continue;
        }
        const heading=line.match(/^(#{1,6})\s+(.+)$/);
        if(heading){ tokens.push({type:'heading',level:heading[1].length,text:heading[2],segments:parseInlineMarkdown2983(heading[2])}); i++; continue; }
        if(/^\s*---+\s*$/.test(line)){tokens.push({type:'rule'});i++;continue;}
        const quote=line.match(/^\s*>\s?(.*)$/);
        if(quote){tokens.push({type:'blockquote',text:quote[1],segments:parseInlineMarkdown2983(quote[1])});i++;continue;}
        const bullet=line.match(/^\s*[-*+]\s+(.+)$/);
        if(bullet){tokens.push({type:'bullet',text:bullet[1],segments:parseInlineMarkdown2983(bullet[1])});i++;continue;}
        if(!line.trim()){tokens.push({type:'blank'});i++;continue;}
        tokens.push({type:'paragraph',segments:parseInlineMarkdown2983(line),text:line}); i++;
      }
      return tokens;
    }

    const LATEX_SYMBOLS={
      alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',theta:'θ',lambda:'λ',mu:'μ',pi:'π',rho:'ρ',sigma:'σ',phi:'φ',omega:'ω',
      Gamma:'Γ',Delta:'Δ',Theta:'Θ',Lambda:'Λ',Pi:'Π',Sigma:'Σ',Phi:'Φ',Omega:'Ω',
      infty:'∞',pm:'±',times:'×',cdot:'·',le:'≤',leq:'≤',ge:'≥',geq:'≥',neq:'≠',approx:'≈',to:'→',rightarrow:'→',leftarrow:'←',
      sum:'∑',prod:'∏',int:'∫',partial:'∂',nabla:'∇',in:'∈',notin:'∉',cup:'∪',cap:'∩',ldots:'…',cdots:'⋯',
    };
    function parseLatex(source){
      const s=String(source||''); let i=0;
      function parseGroup(){
        if(s[i]==='{'){i++;const row=parseRow('}');if(s[i]==='}')i++;return row;}
        return parseAtom();
      }
      function parseCommand(){
        i++;
        if(i>=s.length) return {type:'text',text:'\\'};
        if(!/[A-Za-z]/.test(s[i])) return {type:'text',text:s[i++]};
        let name=''; while(i<s.length&&/[A-Za-z]/.test(s[i])) name+=s[i++];
        if(name==='frac') return {type:'fraction',num:parseGroup(),den:parseGroup()};
        if(name==='sqrt') return {type:'sqrt',body:parseGroup()};
        if(name==='lim') return {type:'operator',name:'lim',limits:true};
        if(name==='text'||name==='mathrm'||name==='mathbf'||name==='mathit') return parseGroup();
        if(name==='left'||name==='right') return parseAtom();
        if(name==='begin'||name==='end'){
          const group=parseGroup(); return {type:'text',text:`${name}(${astText(group)})`};
        }
        return {type:'text',text:LATEX_SYMBOLS[name]||name};
      }
      function parseAtom(){
        let node;
        if(i>=s.length) return {type:'text',text:''};
        if(s[i]==='\\') node=parseCommand();
        else if(s[i]==='{') node=parseGroup();
        else { const ch=s[i++]; node={type:'text',text:ch}; }
        while(i<s.length&&(s[i]==='^'||s[i]==='_')){
          const op=s[i++]; const script=parseGroup();
          if(op==='_' && node?.type==='operator' && node?.limits) node={type:'limit',base:node,below:script};
          else node={type:op==='^'?'sup':'sub',base:node,script};
        }
        return node;
      }
      function parseRow(stop=null){
        const children=[];
        while(i<s.length&&(!stop||s[i]!==stop)){
          if(/\s/.test(s[i])){ let ws=''; while(i<s.length&&/\s/.test(s[i])) ws+=s[i++]; children.push({type:'text',text:' '}); continue; }
          children.push(parseAtom());
        }
        return {type:'row',children};
      }
      return parseRow();
    }
    function astText(ast){
      if(!ast) return '';
      if(ast.type==='text') return ast.text||'';
      if(ast.type==='row') return (ast.children||[]).map(astText).join('');
      if(ast.type==='fraction') return `${astText(ast.num)}/${astText(ast.den)}`;
      if(ast.type==='sqrt') return `√(${astText(ast.body)})`;
      if(ast.type==='operator') return ast.name||'';
      if(ast.type==='limit') return `${astText(ast.base)}_(${astText(ast.below)})`;
      if(ast.type==='sup') return `${astText(ast.base)}^(${astText(ast.script)})`;
      if(ast.type==='sub') return `${astText(ast.base)}_(${astText(ast.script)})`;
      return '';
    }
    function astContainsType(ast,type){
      if(!ast) return false; if(ast.type===type) return true;
      if(ast.type==='row') return (ast.children||[]).some(x=>astContainsType(x,type));
      if(ast.type==='fraction') return astContainsType(ast.num,type)||astContainsType(ast.den,type);
      if(ast.type==='sqrt') return astContainsType(ast.body,type);
      if(ast.type==='limit') return astContainsType(ast.base,type)||astContainsType(ast.below,type);
      if(ast.type==='sup'||ast.type==='sub') return astContainsType(ast.base,type)||astContainsType(ast.script,type);
      return false;
    }
    
    function utf8Bytes(value){ return new TextEncoder().encode(String(value??'')); }
    let CRC32_TABLE=null;
    function crc32(bytes){
      if(!CRC32_TABLE){CRC32_TABLE=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);CRC32_TABLE[n]=c>>>0;}}
      let crc=0xffffffff; for(const byte of bytes) crc=CRC32_TABLE[(crc^byte)&0xff]^(crc>>>8); return (crc^0xffffffff)>>>0;
    }
    function concatBytes(parts){const total=parts.reduce((sum,p)=>sum+p.length,0);const out=new Uint8Array(total);let offset=0;for(const p of parts){out.set(p,offset);offset+=p.length;}return out;}
    function le16(v){return Uint8Array.of(v&0xff,(v>>>8)&0xff);}
    function le32(v){return Uint8Array.of(v&0xff,(v>>>8)&0xff,(v>>>16)&0xff,(v>>>24)&0xff);}
    function zipDosDateTime(date=new Date()){const year=Math.max(1980,date.getFullYear());return {dosTime:((date.getHours()&0x1f)<<11)|((date.getMinutes()&0x3f)<<5)|(Math.floor(date.getSeconds()/2)&0x1f),dosDate:(((year-1980)&0x7f)<<9)|(((date.getMonth()+1)&0xf)<<5)|(date.getDate()&0x1f)};}
    function createStoreZip(entries=[],date=new Date()){
      const localParts=[],centralParts=[];let offset=0;const {dosTime,dosDate}=zipDosDateTime(date);
      for(const entry of entries){
        const nameBytes=utf8Bytes(String(entry.name||'').replace(/\\/g,'/').replace(/^\/+/,'')); const data=entry.data instanceof Uint8Array?entry.data:utf8Bytes(entry.data); const crc=crc32(data),flags=0x0800;
        const local=concatBytes([le32(0x04034b50),le16(20),le16(flags),le16(0),le16(dosTime),le16(dosDate),le32(crc),le32(data.length),le32(data.length),le16(nameBytes.length),le16(0),nameBytes,data]);
        localParts.push(local);
        centralParts.push(concatBytes([le32(0x02014b50),le16(20),le16(20),le16(flags),le16(0),le16(dosTime),le16(dosDate),le32(crc),le32(data.length),le32(data.length),le16(nameBytes.length),le16(0),le16(0),le16(0),le16(0),le32(0),le32(offset),nameBytes]));
        offset+=local.length;
      }
      const central=concatBytes(centralParts); const eocd=concatBytes([le32(0x06054b50),le16(0),le16(0),le16(entries.length),le16(entries.length),le32(central.length),le32(offset),le16(0)]);
      return concatBytes([...localParts,central,eocd]);
    }
    function readStoreZip(bytes){
      const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes); const view=new DataView(data.buffer,data.byteOffset,data.byteLength); const files=new Map(); let offset=0;
      while(offset+30<=data.length&&view.getUint32(offset,true)===0x04034b50){
        const method=view.getUint16(offset+8,true); if(method!==0) throw new Error('only store zip supported');
        const size=view.getUint32(offset+18,true),nameLen=view.getUint16(offset+26,true),extraLen=view.getUint16(offset+28,true); const name=new TextDecoder().decode(data.slice(offset+30,offset+30+nameLen)); const start=offset+30+nameLen+extraLen; files.set(name,data.slice(start,start+size)); offset=start+size;
      }
      return files;
    }
    
    function xmlEscape(value){return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function ommlRun(text){return `<m:r><m:t>${xmlEscape(text)}</m:t></m:r>`;}
    function astToOmml(ast){
      if(!ast) return '';
      if(ast.type==='text') return ommlRun(ast.text||'');
      if(ast.type==='row') return (ast.children||[]).map(astToOmml).join('');
      if(ast.type==='fraction') return `<m:f><m:num>${astToOmml(ast.num)}</m:num><m:den>${astToOmml(ast.den)}</m:den></m:f>`;
      if(ast.type==='sqrt') return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${astToOmml(ast.body)}</m:e></m:rad>`;
      if(ast.type==='operator') return ommlRun(ast.name||'');
      if(ast.type==='limit') return `<m:limLow><m:e>${astToOmml(ast.base)}</m:e><m:lim>${astToOmml(ast.below)}</m:lim></m:limLow>`;
      if(ast.type==='sup') return `<m:sSup><m:e>${astToOmml(ast.base)}</m:e><m:sup>${astToOmml(ast.script)}</m:sup></m:sSup>`;
      if(ast.type==='sub') return `<m:sSub><m:e>${astToOmml(ast.base)}</m:e><m:sub>${astToOmml(ast.script)}</m:sub></m:sSub>`;
      return ommlRun(astText(ast));
    }
    function wordRun(text,bold=false,size=22,{italic=false,code=false,link=false}={}){const props=`<w:rPr>${bold?'<w:b/>':''}${italic?'<w:i/>':''}${code?'<w:rFonts w:ascii="Consolas" w:eastAsia="Microsoft YaHei"/>':''}${link?'<w:u w:val="single"/><w:color w:val="2F65B0"/>':''}<w:sz w:val="${size}"/></w:rPr>`;return `<w:r>${props}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;}
    function paragraphXml(content,style=''){return `<w:p>${style?`<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`:''}${content}</w:p>`;}
    function inlineSegmentsToWordXml(segments=[]){
      return segments.map((segment)=>{
        if(segment.type==='math') return `<m:oMath>${astToOmml(parseLatex(segment.latex))}</m:oMath>`;
        return wordRun(segment.text||'',Boolean(segment.bold),22,{italic:Boolean(segment.italic),code:Boolean(segment.code),link:Boolean(segment.link)});
      }).join('');
    }
    function renderMarkdownToDocxBytes(markdown,{title=''}={}){
      const tokens=tokenizeMarkdown(markdown); const body=[];
      for(const token of tokens){
        if(token.type==='blank'){body.push('<w:p/>');continue;}
        if(token.type==='heading'){body.push(paragraphXml(wordRun(token.text,true,token.level===1?34:28),token.level===1?'Title':'Heading2'));continue;}
        if(token.type==='rule'){body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="D9D9D9"/></w:pBdr></w:pPr></w:p>');continue;}
        if(token.type==='bullet'){body.push(paragraphXml(wordRun('• ')+inlineSegmentsToWordXml(token.segments||[{type:'text',text:token.text||''}])));continue;}
        if(token.type==='blockquote'){body.push(`<w:p><w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:color="C8CBD2"/></w:pBdr></w:pPr>${inlineSegmentsToWordXml(token.segments||[])}</w:p>`);continue;}
        if(token.type==='code'){body.push(paragraphXml(wordRun(token.text)));continue;}
        if(token.type==='paragraph'){body.push(paragraphXml(inlineSegmentsToWordXml(token.segments||[])));continue;}
        if(token.type==='text'){body.push(paragraphXml(wordRun(token.text)));continue;}
        if(token.type==='math'){
          const ast=parseLatex(token.latex); const math=`<m:oMath>${astToOmml(ast)}</m:oMath>`;
          body.push(token.display?`<m:oMathPara>${math}</m:oMathPara>`:paragraphXml(math));
        }
      }
      const document=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
      const styles=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Aptos" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style></w:styles>`;
      const contentTypes=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
      const rootRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
      const docRels=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
      return createStoreZip([{name:'[Content_Types].xml',data:contentTypes},{name:'_rels/.rels',data:rootRels},{name:'word/document.xml',data:document},{name:'word/styles.xml',data:styles},{name:'word/_rels/document.xml.rels',data:docRels}]);
    }
    
    
    function pdfHex(text){
      let out='';
      for(const ch of String(text||'')){
        const cp=ch.codePointAt(0);
        if(cp<=0xffff) out+=cp.toString(16).padStart(4,'0');
        else { const v=cp-0x10000,hi=0xd800+(v>>10),lo=0xdc00+(v&0x3ff); out+=hi.toString(16).padStart(4,'0')+lo.toString(16).padStart(4,'0'); }
      }
      return out.toUpperCase();
    }
    function latinWidthUnits(ch){
      if(ch===' ') return .28;
      if(/[ilI.,:;'`!|]/.test(ch)) return .28;
      if(/[mwMW@]/.test(ch)) return .82;
      if(/[A-Z]/.test(ch)) return .62;
      if(/[a-z0-9]/.test(ch)) return .52;
      return .55;
    }
    function estimateTextWidth(text,size){let units=0;for(const ch of String(text||''))units+=ch.codePointAt(0)<=0x7e?latinWidthUnits(ch):1;return units*size;}
    function wrapText(text,maxWidth,size){
      const lines=[];let current='';let width=0;
      for(const ch of String(text||'')){
        const w=estimateTextWidth(ch,size); if(current&&width+w>maxWidth){lines.push(current);current='';width=0;} current+=ch;width+=w;
      }
      if(current||!lines.length) lines.push(current); return lines;
    }
    function mathMetrics(ast,size){
      if(!ast) return {w:0,h:size,up:size*.75,down:size*.25};
      if(ast.type==='text'){return {w:estimateTextWidth(ast.text,size),h:size,up:size*.75,down:size*.25};}
      if(ast.type==='row'){const ms=(ast.children||[]).map(x=>mathMetrics(x,size));return {w:ms.reduce((s,m)=>s+m.w,0),up:Math.max(size*.75,...ms.map(m=>m.up)),down:Math.max(size*.25,...ms.map(m=>m.down)),h:Math.max(size,...ms.map(m=>m.h))};}
      if(ast.type==='fraction'){const a=mathMetrics(ast.num,size*.78),b=mathMetrics(ast.den,size*.78);const w=Math.max(a.w,b.w)+8;return {w,up:a.h+4,down:b.h+4,h:a.h+b.h+8};}
      if(ast.type==='sqrt'){const m=mathMetrics(ast.body,size);return {w:m.w+size*.75,up:m.up+3,down:m.down,h:m.h+3};}
      if(ast.type==='operator') return mathMetrics({type:'text',text:ast.name||''},size);
      if(ast.type==='limit'){const b=mathMetrics(ast.base,size),l=mathMetrics(ast.below,size*.62);return {w:Math.max(b.w,l.w),up:b.up,down:b.down+l.h*.95,h:b.h+l.h*.95};}
      if(ast.type==='sup'){const b=mathMetrics(ast.base,size),s=mathMetrics(ast.script,size*.65);return {w:b.w+s.w,up:Math.max(b.up,b.up+s.h*.75),down:b.down,h:Math.max(b.h,b.h+s.h*.45)};}
      if(ast.type==='sub'){const b=mathMetrics(ast.base,size),s=mathMetrics(ast.script,size*.65);return {w:b.w+s.w,up:b.up,down:Math.max(b.down,b.down+s.h*.75),h:Math.max(b.h,b.h+s.h*.45)};}
      return mathMetrics({type:'text',text:astText(ast)},size);
    }
    function renderPdfGlyphs(text,x,baseline,size,ops){
      let dx=0;
      for(const ch of String(text||'')){
        const latin=ch.codePointAt(0)<=0x7e;
        const hex=latin?ch.codePointAt(0).toString(16).padStart(2,'0').toUpperCase():pdfHex(ch);
        ops.push(`BT 1 0 0 1 ${(x+dx).toFixed(2)} ${baseline.toFixed(2)} Tm /${latin?'F2':'F1'} ${size.toFixed(2)} Tf <${hex}> Tj ET`);
        dx+=estimateTextWidth(ch,size);
      }
      return dx;
    }
    function renderMathOps(ast,x,baseline,size,ops){
      if(!ast) return 0;
      if(ast.type==='text') return renderPdfGlyphs(ast.text||'',x,baseline,size,ops);
      if(ast.type==='row'){let dx=0;for(const child of ast.children||[])dx+=renderMathOps(child,x+dx,baseline,size,ops);return dx;}
      if(ast.type==='fraction'){
        const n=mathMetrics(ast.num,size*.78),d=mathMetrics(ast.den,size*.78),m=mathMetrics(ast,size);const nx=x+(m.w-n.w)/2,dx=x+(m.w-d.w)/2;
        renderMathOps(ast.num,nx,baseline+size*.65,size*.78,ops);renderMathOps(ast.den,dx,baseline-size*.65,size*.78,ops);
        ops.push(`${x.toFixed(2)} ${(baseline+size*.18).toFixed(2)} m ${(x+m.w).toFixed(2)} ${(baseline+size*.18).toFixed(2)} l 0.7 w S`);return m.w;
      }
      if(ast.type==='sqrt'){
        const m=mathMetrics(ast,size);renderPdfGlyphs('√',x,baseline,size*1.08,ops);
        const bodyX=x+size*.72;renderMathOps(ast.body,bodyX,baseline,size,ops);ops.push(`${bodyX.toFixed(2)} ${(baseline+size*.9).toFixed(2)} m ${(x+m.w).toFixed(2)} ${(baseline+size*.9).toFixed(2)} l 0.55 w S`);return m.w;
      }
      if(ast.type==='operator') return renderPdfGlyphs(ast.name||'',x,baseline,size,ops);
      if(ast.type==='limit'){
        const bm=mathMetrics(ast.base,size),lm=mathMetrics(ast.below,size*.62),m=mathMetrics(ast,size);
        renderMathOps(ast.base,x+(m.w-bm.w)/2,baseline,size,ops);
        renderMathOps(ast.below,x+(m.w-lm.w)/2,baseline-size*.72,size*.62,ops);
        return m.w;
      }
      if(ast.type==='sup'){const b=renderMathOps(ast.base,x,baseline,size,ops);const ss=renderMathOps(ast.script,x+b,baseline+size*.55,size*.65,ops);return b+ss;}
      if(ast.type==='sub'){const b=renderMathOps(ast.base,x,baseline,size,ops);const ss=renderMathOps(ast.script,x+b,baseline-size*.38,size*.65,ops);return b+ss;}
      return renderMathOps({type:'text',text:astText(ast)},x,baseline,size,ops);
    }
    
    function buildToUnicode(chars){
      const unique=[...new Set([...chars].filter(ch=>ch.codePointAt(0)<=0xffff))].sort((a,b)=>a.codePointAt(0)-b.codePointAt(0));
      const rows=unique.map(ch=>`<${ch.codePointAt(0).toString(16).padStart(4,'0').toUpperCase()}> <${ch.codePointAt(0).toString(16).padStart(4,'0').toUpperCase()}>`);
      return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /AIChatFlowUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${rows.length} beginbfchar\n${rows.join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
    }
    function pdfDisplayText(text){
      return String(text||'').replace(/👤\s*/g,'').replace(/🤖\s*/g,'');
    }

    const KATEX_PDF_VERSION = "0.16.27";
    const KATEX_PDF_MACROS = Object.freeze({ "\\arccot":"\\operatorname{arccot}" });
    const katexFormulaBitmapCache = new Map();
    function katexFormulaFallbackBitmap(latex,{fontPx=22,color='#111111'}={}){
      const text=`$${String(latex||'').trim()}$`;
      const c=document.createElement('canvas');
      const x=c.getContext('2d',{alpha:true});
      x.font=`${fontPx}px Consolas,"Cascadia Mono",monospace`;
      const width=Math.max(8,Math.ceil(x.measureText(text).width+8)),height=Math.max(16,Math.ceil(fontPx*1.55));
      c.width=width;c.height=height;
      const ctx=c.getContext('2d',{alpha:true});ctx.clearRect(0,0,width,height);ctx.font=`${fontPx}px Consolas,"Cascadia Mono",monospace`;ctx.fillStyle=color;ctx.textBaseline='alphabetic';ctx.fillText(text,4,Math.round(fontPx*1.08));
      return {canvas:c,width,height,baseline:Math.round(fontPx*1.08),ok:false};
    }
    async function renderKatexFormulaBitmap(latex,{displayMode=false,fontPx=22,color='#111111'}={}){
      if(typeof document==='undefined'||!document.body||typeof Image==='undefined') throw new Error('KaTeX PDF 渲染需要浏览器 DOM/Image 环境');
      const tex=String(latex||'').trim();
      const key=`${displayMode?'D':'I'}|${fontPx}|${color}|${tex}`;
      if(katexFormulaBitmapCache.has(key)) return katexFormulaBitmapCache.get(key);
      const task=(async()=>{
        if(!tex) return katexFormulaFallbackBitmap('',{fontPx,color});
        let markup='';
        try{
          markup=AIChatFlowKaTeX.renderToString(tex,{throwOnError:true,output:'mathml',displayMode,strict:'ignore',trust:false,macros:KATEX_PDF_MACROS});
        }catch(error){
          console.warn('[AI 对话流转] KaTeX 无法解析公式，保留原始 LaTeX：',tex,error);
          return katexFormulaFallbackBitmap(tex,{fontPx,color});
        }
        // annotation carries the original TeX for accessibility but is not needed for rasterization.
        markup=markup.replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/gi,'');
        const host=document.createElement(displayMode?'div':'span');
        host.setAttribute('data-ai-chat-flow-katex','measure');
        host.style.cssText=`position:fixed;left:-100000px;top:0;z-index:-2147483648;display:${displayMode?'inline-block':'inline'};visibility:hidden;white-space:nowrap;font-size:${fontPx}px;line-height:normal;color:${color};font-family:"Cambria Math","STIX Two Math","Latin Modern Math",serif;padding:2px;margin:0;border:0;`;
        host.innerHTML=markup;
        let marker=null;
        if(!displayMode){marker=document.createElement('span');marker.style.cssText='display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;';host.appendChild(marker);}
        document.body.appendChild(host);
        // getBoundingClientRect() forces layout; avoid requestAnimationFrame so exports keep working in background tabs.
        const rect=host.getBoundingClientRect();
        const width=Math.max(8,Math.ceil(rect.width+6)),height=Math.max(12,Math.ceil(rect.height+6));
        let baseline=Math.round(height*.78);
        if(marker){const mr=marker.getBoundingClientRect();baseline=Math.max(1,Math.min(height-1,Math.round(mr.top-rect.top+3)));}
        host.remove();
        const style=`display:inline-block;white-space:nowrap;font-size:${fontPx}px;line-height:normal;color:${color};font-family:&quot;Cambria Math&quot;,&quot;STIX Two Math&quot;,&quot;Latin Modern Math&quot;,serif;padding:2px;margin:0;border:0;`;
        const inner=`<div xmlns="http://www.w3.org/1999/xhtml" style="${style}">${markup}</div>`;
        const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${inner}</foreignObject></svg>`;
        const image=new Image();
        const dataUrl=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await new Promise((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>{if(!settled){settled=true;reject(new Error('公式位图加载超时'));}},3500);image.onload=()=>{if(!settled){settled=true;clearTimeout(timer);resolve();}};image.onerror=()=>{if(!settled){settled=true;clearTimeout(timer);reject(new Error('公式 SVG 位图解码失败'));}};image.src=dataUrl;});
        const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d',{alpha:true});if(!ctx) throw new Error('公式 Canvas 2D 不可用');ctx.clearRect(0,0,width,height);ctx.drawImage(image,0,0,width,height);
        return {canvas:c,width,height,baseline,ok:true};
      })().catch(error=>{console.warn('[AI 对话流转] KaTeX 位图渲染失败，保留原始 LaTeX：',tex,error);return katexFormulaFallbackBitmap(tex,{fontPx,color});});
      katexFormulaBitmapCache.set(key,task);
      return task;
    }
    async function renderMarkdownToPdfBytes(markdown,{title=''}={}){
      if(typeof document==='undefined'||typeof document.createElement!=='function') throw new Error('PDF 渲染需要浏览器 Canvas 环境');
      const tokens=tokenizeMarkdown(markdown);
      const canvas=document.createElement('canvas');
      canvas.width=1240; canvas.height=1754;
      const ctx=canvas.getContext('2d',{alpha:true});
      if(!ctx) throw new Error('浏览器 Canvas 2D 不可用，无法生成 PDF');
      const pageW=595.28,pageH=841.89,margin=92,contentW=canvas.width-margin*2;
      const pages=[]; let y=margin; let pageHasContent=false; let activeMessage=null;
      const fontFamily='"Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Source Han Sans SC","Arial Unicode MS",sans-serif';
      const mathFamily='"Cambria Math","STIX Two Math","Times New Roman","Microsoft YaHei",serif';
      const monoFamily='Consolas,"Cascadia Mono","SFMono-Regular",monospace';
      const resetPage=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#111111';ctx.textBaseline='alphabetic';ctx.textAlign='left';y=margin;pageHasContent=false;};
      const paintPageBackground=()=>{ctx.save();ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#FFFFFF';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.restore();};
      const dataUrlBytes=(url)=>{const b64=String(url||'').split(',')[1]||'';const bin=atob(b64);const out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i)&255;return out;};
      const roundedRectPath=(x0,y0,w,h,r)=>{const rr=Math.max(0,Math.min(r,w/2,h/2));ctx.beginPath();ctx.moveTo(x0+rr,y0);ctx.lineTo(x0+w-rr,y0);ctx.quadraticCurveTo(x0+w,y0,x0+w,y0+rr);ctx.lineTo(x0+w,y0+h-rr);ctx.quadraticCurveTo(x0+w,y0+h,x0+w-rr,y0+h);ctx.lineTo(x0+rr,y0+h);ctx.quadraticCurveTo(x0,y0+h,x0,y0+h-rr);ctx.lineTo(x0,y0+rr);ctx.quadraticCurveTo(x0,y0,x0+rr,y0);ctx.closePath();};
      const paintBubble=(message,endY)=>{if(!message)return;const start=Math.max(margin,message.segmentStartY||margin),end=Math.max(start+44,Math.min(canvas.height-margin,endY));ctx.save();ctx.globalCompositeOperation='destination-over';ctx.fillStyle=message.role==='user'?'#EEF5FF':'#F5F6F8';roundedRectPath(message.x,start,message.width,end-start,24);ctx.fill();ctx.restore();};
      const setFont=(size,{weight=400,italic=false,mono=false,math=false}={})=>{ctx.font=`${italic?'italic ':'normal '}${weight} ${size}px ${mono?monoFamily:math?mathFamily:fontFamily}`;};
      const drawRoleLabel=(continued=false)=>{if(!activeMessage)return;const label=activeMessage.role==='user'?'用户':'AI 助手';setFont(16,{weight:700});ctx.fillStyle=activeMessage.role==='user'?'#315F95':'#5A5E67';ctx.fillText(`${label}${continued?'（续）':''}`,activeMessage.x+activeMessage.pad,y+16);y+=30;pageHasContent=true;};
      const flushPage=()=>{const continuing=activeMessage?{...activeMessage}:null;if(activeMessage)paintBubble(activeMessage,y+activeMessage.pad);paintPageBackground();pages.push(dataUrlBytes(canvas.toDataURL('image/jpeg',0.92)));resetPage();if(continuing){activeMessage=continuing;activeMessage.segmentStartY=margin;y=margin+activeMessage.pad;drawRoleLabel(true);}};
      const ensure=(need)=>{if(y+need>canvas.height-margin&&pageHasContent)flushPage();};
      const currentBounds=()=>activeMessage?{left:activeMessage.x+activeMessage.pad,width:activeMessage.width-activeMessage.pad*2,right:activeMessage.x+activeMessage.width-activeMessage.pad}:{left:margin,width:contentW,right:canvas.width-margin};
      const beginMessage=(role)=>{if(activeMessage)endMessage();ensure(70);const ratio=role==='user'?0.72:0.86;const width=Math.round(contentW*ratio);const x=role==='user'?canvas.width-margin-width:margin;activeMessage={role,x,width,pad:24,segmentStartY:y};y+=activeMessage.pad;drawRoleLabel(false);};
      const endMessage=()=>{if(!activeMessage)return;paintBubble(activeMessage,y+activeMessage.pad);y+=activeMessage.pad+18;activeMessage=null;};
      const charWidth=(ch,size,opts={})=>{setFont(size,opts);return Math.max(1,ctx.measureText(ch).width);};
      const wrapPlain=(text,size,maxWidth,opts={})=>{const out=[];let line='';let w=0;for(const ch of String(text||'')){if(ch==='\n'){out.push(line);line='';w=0;continue;}const cw=charWidth(ch,size,opts);if(line&&w+cw>maxWidth){out.push(line);line='';w=0;}line+=ch;w+=cw;}out.push(line);return out;};
      const mathMeasure=(ast,size)=>{
        if(!ast)return{w:0,up:size*.8,down:size*.25};
        if(ast.type==='text'||ast.type==='operator'){setFont(size,{math:true});return{w:ctx.measureText(ast.type==='operator'?(ast.name||''):(ast.text||'')).width,up:size*.8,down:size*.25};}
        if(ast.type==='row'){const ms=(ast.children||[]).map(x=>mathMeasure(x,size));return{w:ms.reduce((a,m)=>a+m.w,0),up:Math.max(size*.8,...ms.map(m=>m.up)),down:Math.max(size*.25,...ms.map(m=>m.down))};}
        if(ast.type==='fraction'){const a=mathMeasure(ast.num,size*.76),b=mathMeasure(ast.den,size*.76);return{w:Math.max(a.w,b.w)+12,up:a.up+a.down+size*.55,down:b.up+b.down+size*.45};}
        if(ast.type==='sqrt'){const m=mathMeasure(ast.body,size);return{w:m.w+size*.8,up:m.up+4,down:m.down};}
        if(ast.type==='limit'){const b=mathMeasure(ast.base,size),l=mathMeasure(ast.below,size*.62);return{w:Math.max(b.w,l.w),up:b.up,down:b.down+l.up+l.down};}
        if(ast.type==='sup'){const b=mathMeasure(ast.base,size),q=mathMeasure(ast.script,size*.62);return{w:b.w+q.w,up:Math.max(b.up,b.up+q.up),down:b.down};}
        if(ast.type==='sub'){const b=mathMeasure(ast.base,size),q=mathMeasure(ast.script,size*.62);return{w:b.w+q.w,up:b.up,down:Math.max(b.down,b.down+q.down+q.up*.7)};}
        return mathMeasure({type:'text',text:astText(ast)},size);
      };
      const drawMath=(ast,x,baseline,size)=>{
        if(!ast)return 0;ctx.fillStyle='#111111';ctx.strokeStyle='#111111';ctx.lineWidth=Math.max(1,size/22);
        if(ast.type==='text'||ast.type==='operator'){const text=ast.type==='operator'?(ast.name||''):(ast.text||'');setFont(size,{math:true});ctx.fillText(text,x,baseline);return ctx.measureText(text).width;}
        if(ast.type==='row'){let dx=0;for(const child of ast.children||[])dx+=drawMath(child,x+dx,baseline,size);return dx;}
        if(ast.type==='fraction'){const nm=mathMeasure(ast.num,size*.76),dm=mathMeasure(ast.den,size*.76),m=mathMeasure(ast,size);drawMath(ast.num,x+(m.w-nm.w)/2,baseline-size*.42,size*.76);drawMath(ast.den,x+(m.w-dm.w)/2,baseline+size*.72,size*.76);ctx.beginPath();ctx.moveTo(x,baseline+size*.08);ctx.lineTo(x+m.w,baseline+size*.08);ctx.stroke();return m.w;}
        if(ast.type==='sqrt'){const m=mathMeasure(ast,size);setFont(size*1.05,{math:true});ctx.fillText('√',x,baseline);const rootW=ctx.measureText('√').width*.82;drawMath(ast.body,x+rootW,baseline,size);ctx.beginPath();ctx.moveTo(x+rootW,baseline-size*.86);ctx.lineTo(x+m.w,baseline-size*.86);ctx.stroke();return m.w;}
        if(ast.type==='limit'){const bm=mathMeasure(ast.base,size),lm=mathMeasure(ast.below,size*.62),m=mathMeasure(ast,size);drawMath(ast.base,x+(m.w-bm.w)/2,baseline,size);drawMath(ast.below,x+(m.w-lm.w)/2,baseline+size*.75,size*.62);return m.w;}
        if(ast.type==='sup'){const b=drawMath(ast.base,x,baseline,size);return b+drawMath(ast.script,x+b,baseline-size*.55,size*.62);}
        if(ast.type==='sub'){const b=drawMath(ast.base,x,baseline,size);return b+drawMath(ast.script,x+b,baseline+size*.48,size*.62);}
        return drawMath({type:'text',text:astText(ast)},x,baseline,size);
      };
      const drawPlainLines=(text,size,{indent=0,weight=400,italic=false,mono=false,lineHeight=Math.round(size*1.55),color='#111111'}={})=>{
        const bounds=currentBounds(),lines=wrapPlain(pdfDisplayText(text),size,Math.max(20,bounds.width-indent),{weight,italic,mono});
        for(const line of lines){ensure(lineHeight+4);const b=currentBounds();setFont(size,{weight,italic,mono});ctx.fillStyle=color;ctx.fillText(line,b.left+indent,y+size);y+=lineHeight;pageHasContent=true;}return lines.length;
      };
      const drawSegments=async(segments,size=22,{indent=0,lineHeight=Math.round(size*1.55),baseWeight=400,baseItalic=false,color='#111111'}={})=>{
        ensure(lineHeight+8);let bounds=currentBounds(),x=bounds.left+indent,baseline=y+size,currentHeight=lineHeight;
        const newline=()=>{y+=currentHeight;ensure(lineHeight+8);bounds=currentBounds();x=bounds.left+indent;baseline=y+size;currentHeight=lineHeight;};
        for(const segment of segments||[]){
          if(segment.type==='math'){
            const bmp=await renderKatexFormulaBitmap(segment.latex,{displayMode:false,fontPx:size,color});
            bounds=currentBounds();
            if(x>bounds.left+indent&&x+bmp.width>bounds.right)newline();
            let scale=Math.min(1,Math.max(.5,(bounds.right-x)/Math.max(1,bmp.width)));
            const dw=bmp.width*scale,dh=bmp.height*scale,db=bmp.baseline*scale;
            ctx.drawImage(bmp.canvas,x,baseline-db,dw,dh);x+=dw;currentHeight=Math.max(currentHeight,dh+8);pageHasContent=true;continue;
          }
          const text=pdfDisplayText(segment.text||'');const opts={weight:segment.bold?700:baseWeight,italic:Boolean(segment.italic||baseItalic),mono:Boolean(segment.code)};
          for(const ch of text){if(ch==='\n'){newline();continue;}bounds=currentBounds();const w=charWidth(ch,size,opts);if(x>bounds.left+indent&&x+w>bounds.right)newline();if(segment.code){ctx.fillStyle='#E8EAEE';ctx.fillRect(x-2,baseline-size+2,w+4,size+8);}setFont(size,opts);ctx.fillStyle=segment.link?'#2F65B0':color;ctx.fillText(ch,x,baseline);if(segment.link){ctx.strokeStyle='#2F65B0';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,baseline+3);ctx.lineTo(x+w,baseline+3);ctx.stroke();}x+=w;pageHasContent=true;}
        }
        y+=currentHeight;
      };
      const drawCodeBlock=(text)=>{const size=18,lh=28;for(const sourceLine of String(text||'').split('\n')){const b=currentBounds(),lines=wrapPlain(sourceLine,size,Math.max(20,b.width-28),{mono:true});for(const line of lines){ensure(lh+8);const bb=currentBounds();ctx.fillStyle='#ECEEF2';ctx.fillRect(bb.left,y,bb.width,lh+5);setFont(size,{mono:true});ctx.fillStyle='#202124';ctx.fillText(line,bb.left+14,y+size+2);y+=lh;pageHasContent=true;}}y+=6;};
      resetPage();
      for(const token of tokens){
        if(token.type==='heading'&&token.level===2){const roleText=pdfDisplayText(token.text).trim();if(roleText==='用户'){beginMessage('user');continue;}if(roleText==='AI 助手'||roleText==='AI助手'){beginMessage('assistant');continue;}}
        if(token.type==='rule'&&activeMessage){endMessage();continue;}
        if(token.type==='blank'){y+=activeMessage?8:12;continue;}
        if(token.type==='heading'){const size=token.level===1?42:token.level===2?30:25,lh=Math.round(size*1.45);await drawSegments(token.segments||[{type:'text',text:token.text||''}],size,{lineHeight:lh,baseWeight:700});y+=token.level===1?14:6;continue;}
        if(token.type==='rule'){ensure(24);const b=currentBounds();ctx.strokeStyle='#D0D0D0';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(b.left,y+6);ctx.lineTo(b.right,y+6);ctx.stroke();y+=24;pageHasContent=true;continue;}
        if(token.type==='bullet'){ensure(42);const b=currentBounds();ctx.fillStyle='#333333';ctx.beginPath();ctx.arc(b.left+7,y+16,4,0,Math.PI*2);ctx.fill();await drawSegments(token.segments||[{type:'text',text:token.text||''}],22,{indent:24,lineHeight:34});continue;}
        if(token.type==='blockquote'){ensure(42);const b=currentBounds();ctx.strokeStyle='#C3C6CE';ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(b.left+4,y+2);ctx.lineTo(b.left+4,y+34);ctx.stroke();await drawSegments(token.segments||[],21,{indent:22,lineHeight:33,baseItalic:true,color:'#4F535C'});continue;}
        if(token.type==='code'){drawCodeBlock(token.text);continue;}
        if(token.type==='paragraph'){await drawSegments(token.segments||[],22,{lineHeight:34});continue;}
        if(token.type==='text'){drawPlainLines(token.text,22,{lineHeight:34});continue;}
        if(token.type==='math'){const size=token.display?30:22,bmp=await renderKatexFormulaBitmap(token.latex,{displayMode:Boolean(token.display),fontPx:size,color:'#111111'});const b=currentBounds(),scale=Math.min(1,b.width/Math.max(1,bmp.width)),dw=bmp.width*scale,dh=bmp.height*scale,need=Math.max(52,dh+24);ensure(need);const bb=currentBounds(),x=token.display?bb.left+Math.max(0,(bb.width-dw)/2):bb.left;ctx.drawImage(bmp.canvas,x,y+10,dw,dh);y+=need;pageHasContent=true;continue;}
      }
      if(activeMessage)endMessage();
      if(pageHasContent||pages.length===0)flushPage();
      const ascii=(text)=>new TextEncoder().encode(text);
      const concat=(parts)=>{const total=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(total);let off=0;for(const part of parts){out.set(part,off);off+=part.length;}return out;};
      const objectCount=2+pages.length*3;const objects=new Array(objectCount);const pageIds=[];
      objects[0]=[ascii('<< /Type /Catalog /Pages 2 0 R >>')];
      for(let i=0;i<pages.length;i++){
        const imageId=3+i*3,contentId=imageId+1,pageId=imageId+2;pageIds.push(pageId);const jpeg=pages[i];
        objects[imageId-1]=[ascii(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,ascii('\nendstream')];
        const content=`q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im${i+1} Do\nQ\n`;
        objects[contentId-1]=[ascii(`<< /Length ${ascii(content).length} >>\nstream\n${content}endstream`)];
        objects[pageId-1]=[ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im${i+1} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)];
      }
      objects[1]=[ascii(`<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)];
      const chunks=[ascii(`%PDF-1.4\n%AIChatFlow-Raster\n%AIChatFlow-Renderer:${VIEW_RENDER_VERSION_2983}\n%AIChatFlow-KaTeX:${KATEX_PDF_VERSION}\n`)],offsets=[0];let length=chunks[0].length;
      for(let i=0;i<objects.length;i++){offsets.push(length);const prefix=ascii(`${i+1} 0 obj\n`),suffix=ascii('\nendobj\n');chunks.push(prefix,...objects[i],suffix);length+=prefix.length+objects[i].reduce((n,p)=>n+p.length,0)+suffix.length;}
      const xrefOffset=length;let xref=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)xref+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;xref+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;chunks.push(ascii(xref));
      return concat(chunks);
    }
    
    
    return {
      cleanSegment,shortId,sanitizeProjectName,normalizeProject,fetchProjects,fetchProjectConversations,collectProjectInventorySafe,mergeInventoryWithProjects,planPersistentViews,
      isVisibleChatMessage,cleanConversation,renderCleanMarkdown,tokenizeMarkdown,parseLatex,astText,astContainsType,
      createStoreZip,readStoreZip,renderMarkdownToDocxBytes,renderMarkdownToPdfBytes,astToOmml,
    };
    
  })();

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
    libraryLayout299, mapLegacyLibraryPath299, normalizeExtractionSourceMode, extractionProjectViewMemberships, extractionPathsForSource,
    ensureArchiveStructure299:ensureArchiveStructure, migrateLegacyEngineeringLayout299,
    uniqueFlatExtractionName, collectDirectoryFilesFlat, copyDirectoryContentsFlat,
    crc32, createStoreZip, V295,
    backfillLibraryViews295,
    localAuditPolicy2984, partitionSyncQueueByLocalRisk2984, migrationConflictPolicy2984, isUserManagedConfigTarget2984, managedConversationAssetType2984, managementNonblockingCount2984, preflightManagedAssets2983,
    userConfigConflictsFromMigration2984, userConfigConflictCounts2984, copyManagedAssetManifest281,
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

  function auditRootForKind299(kind) { return kind === "JSON" ? JSON_ROOT : MARKDOWN_ROOT; }

  async function readObservedFileIdentity(root, handle, kind, path) {
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
      const jsonPath = joinPath(JSON_ROOT, String(path || "").replace(/\.md$/i, ".json"));
      try { conversationId = String((await readJson(root, jsonPath))?.conversation_id || ""); }
      catch { conversationId = ""; }
    }
    return conversationId ? { conversation_id: conversationId, kind, path: joinPath(auditRootForKind299(kind), path) } : null;
  }

  async function conversationIdsDirectlyInFolder(root, folderPath) {
    const folder = String(folderPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const ids = new Set();
    if (!folder) return [];
    for (const kind of ["JSON", "Markdown"]) {
      try {
        const directory = await getDirectory(root, joinPath(auditRootForKind299(kind), folder), false);
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind !== "file") continue;
          if (kind === "JSON" && !/\.json$/i.test(name)) continue;
          if (kind === "Markdown" && !/\.md$/i.test(name)) continue;
          try {
            const observed = await readObservedFileIdentity(root, handle, kind, joinPath(folder, name));
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
            const observed = await readObservedFileIdentity(root, handle, kind, path);
            if (observed) observedFiles.push(observed);
            else {
              unreadableFiles.push(`${auditRootForKind299(kind)}/${path}: 缺少 conversation_id`);
              unreadableEntries.push({ kind, path: joinPath(auditRootForKind299(kind), path), reason: "缺少 conversation_id" });
            }
          } catch (error) {
            unreadableFiles.push(`${auditRootForKind299(kind)}/${path}: ${error.message}`);
            unreadableEntries.push({ kind, path: joinPath(auditRootForKind299(kind), path), reason: error.message || String(error) });
          }
        }
        if (cancelRequested) throw new Error("用户已取消扫描");
      }
    };
    for (const kind of ["JSON", "Markdown"]) {
      try {
        const directory = await getDirectory(root, auditRootForKind299(kind), false);
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
    "state-conflict": "位置冲突",
    "state-uncertain": "位置无法确认",
  };

  function isMissingOnlyIssue(issue) {
    const types = new Set(issue?.types || []);
    return types.size > 0 && [...types].every((type) => ["missing-json", "missing-markdown"].includes(type));
  }

  function localAuditPolicy2984(audit = {}) {
    const deferred = new Set();
    const add = (value) => { const id=String(value || "").trim(); if (id) deferred.add(id); };
    for (const change of audit?.stateChangeResult?.changes || audit?.conversationChanges || []) {
      if (["conflict","uncertain"].includes(String(change?.type || ""))) add(change?.conversation_id);
    }
    for (const issue of audit?.missingFileIssues || []) add(issue?.conversation_id);
    let nonblockingOrganizationCount = 0;
    const riskTypesAllowed=new Set(["missing-json","missing-markdown","duplicate-json","duplicate-markdown","split-folders","index-drift","state-conflict","state-uncertain"]);
    const organizationOnly=new Set(["unclassified","wrong-target"]);
    for (const issue of audit?.conversationIssues || []) {
      const types=[...new Set(issue?.types || [])];
      const riskTypes=types.filter((type)=>riskTypesAllowed.has(type));
      if (riskTypes.length) add(issue?.conversation_id);
      else if (types.some((type)=>organizationOnly.has(type))) nonblockingOrganizationCount += 1;
    }
    nonblockingOrganizationCount += (audit?.folderChanges || []).filter((item)=>item?.type === "decide-empty-folder").length;
    return {
      block_all:audit?.stateChangeResult?.trusted === false,
      deferred_conversation_ids:[...deferred],
      nonblocking_organization_count:nonblockingOrganizationCount,
    };
  }

  function partitionSyncQueueByLocalRisk2984(queue = [], audit = {}) {
    const policy=localAuditPolicy2984(audit);
    const deferredIds=new Set(policy.deferred_conversation_ids);
    const runnable=[], deferred=[];
    for (const item of Array.isArray(queue) ? queue : []) {
      const id=String(item?.id || item?.conversation_id || "");
      (deferredIds.has(id) ? deferred : runnable).push(item);
    }
    return { ...policy, runnable, deferred };
  }

  function missingIssueText(issue) {
    const missingJson = issue?.types?.includes("missing-json");
    const missingMarkdown = issue?.types?.includes("missing-markdown");
    if (missingJson && missingMarkdown) return "JSON 和 Markdown 都已经找不到。若这是你之前手动删除的，直接确认即可；插件会清理索引并记录删除状态。";
    if (missingJson) return "JSON 已经找不到，但 Markdown 还在。若你本来就是要删除这个对话，可以删除整个对话；否则先不要操作。";
    if (missingMarkdown) return "Markdown 已经找不到，但 JSON 还在。若你本来就是要删除这个对话，可以删除整个对话；否则先不要操作。";
    return "本地文件状态需要确认。";
  }

  function organizerIssuesFromAudit295(audit = {}) {
    const base = (audit?.conversationIssues || []).filter((issue) => !isMissingOnlyIssue(issue));
    const byId = new Map(base.map((issue) => [String(issue?.conversation_id || ""), { ...issue }]));
    const pathList = (representation) => {
      const candidates = (Array.isArray(representation?.candidates) ? representation.candidates : [])
        .map((value) => normalizeStatePath(value)).filter(Boolean);
      if (candidates.length) return [...new Set(candidates)];
      const fallback = normalizeStatePath(representation?.to || representation?.from || "");
      return fallback ? [fallback] : [];
    };
    for (const change of audit?.stateChangeResult?.changes || audit?.conversationChanges || []) {
      if (!["conflict", "uncertain"].includes(change?.type)) continue;
      const id = String(change?.conversation_id || "");
      if (!id) continue;
      const existing = byId.get(id);
      const reps = Array.isArray(change?.representations) ? change.representations : [];
      const jsonPaths = [...new Set(reps.filter((rep) => rep?.kind === "json").flatMap(pathList))];
      const markdownPaths = [...new Set(reps.filter((rep) => rep?.kind === "markdown").flatMap(pathList))];
      if (existing) {
        existing.types = [...new Set([...(existing.types || []), change.type === "conflict" ? "state-conflict" : "state-uncertain"])];
        existing.json_paths = [...new Set([...(existing.json_paths || []), ...jsonPaths])];
        existing.markdown_paths = [...new Set([...(existing.markdown_paths || []), ...markdownPaths])];
        continue;
      }
      byId.set(id, {
        conversation_id: id,
        title: change?.title || "未命名对话",
        types: [change.type === "conflict" ? "state-conflict" : "state-uncertain"],
        json_paths: jsonPaths,
        markdown_paths: markdownPaths,
        indexed_json: reps.find((rep) => rep?.kind === "json")?.from || null,
        indexed_markdown: reps.find((rep) => rep?.kind === "markdown")?.from || null,
        classification: null,
        desired_paths: null,
      });
    }
    return [...byId.values()].sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "zh-CN") || String(a.conversation_id || "").localeCompare(String(b.conversation_id || "")));
  }

  function renderConversationIssues(audit = ui?._folderAudit) {
    if (!ui?.organizer || !ui?.issueList || !ui?.issueTargetRule) return;
    const issues = organizerIssuesFromAudit295(audit);
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
    const issueMap = new Map(organizerIssuesFromAudit295(ui._folderAudit).map((issue) => [issue.conversation_id, issue]));
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
    const rootName = kind === "json" ? JSON_ROOT : MARKDOWN_ROOT;
    const prefix = `${rootName}/`;
    const relative = normalized.toLowerCase().startsWith(prefix.toLowerCase()) ? normalized.slice(prefix.length) : normalized;
    return joinPath(SYSTEM_DELETED_FOLDER, rootName, relative);
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
    const entry = index.conversations[id] || {};
    const state = await loadConversationState(root);
    const deleted = await loadDeletedConversations(root);
    const sourcePaths = [...new Set([
      ...(Array.isArray(entry.view_paths) ? entry.view_paths : []),
      entry.raw_path, entry.json_path, entry.markdown_path, entry.pdf_path,
      currentPathForRepresentation(change, "json"), currentPathForRepresentation(change, "markdown"),
    ].map(normalizeStatePath).filter(Boolean))];
    const moved = [];
    for (const source of sourcePaths) {
      const destination = joinPath(SYSTEM_DELETED_FOLDER, source);
      try {
        const handle = await getFileHandle(root, source, false);
        const file = await handle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        await writeBinary(root, destination, bytes);
        await removeFile(root, source);
        moved.push({ source, destination });
        try { await removeEmptyAncestorDirectories(root, source); } catch { /* best effort */ }
      } catch (error) {
        if (error?.name !== "NotFoundError") throw error;
      }
    }
    const deletedJson = moved.find((item) => item.source === normalizeStatePath(entry.json_path))?.destination || "";
    const deletedMarkdown = moved.find((item) => item.source === normalizeStatePath(entry.markdown_path))?.destination || "";
    const previous = state.conversations[id] || stateEntryFromIndexEntry(entry);
    state.conversations[id] = normalizeStateEntry({
      ...previous, title: change.title || previous.title, state: "deleted",
      last_known: { json_path: deletedJson, markdown_path: deletedMarkdown },
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
      if (!archives.issues.length) await writeJson(root, TIMELINE_PATH, timelineFromArchives(archives.archives));
    } catch { /* keep old timeline on non-critical failure */ }
    return { conversation_id: id, type: "delete", view_paths: moved.map((item) => item.destination), raw_path: entry.raw_path || "", pdf_path: entry.pdf_path || "" };
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
    const existingEntry = index.conversations[id] || null;
    const jsonSource = currentPathForRepresentation(change, "json");
    if (!jsonSource && !existingEntry) throw new Error("移动需要可读取的本地档案；当前索引和 JSON 都不可用");
    const archive = (await readRawArchive295(root, { ...(existingEntry || {}), json_path: jsonSource || existingEntry?.json_path || "" })).archive;
    if (String(archive?.conversation_id || "") !== id) throw new Error("当前原始档案 conversation_id 与待移动对话不一致");
    const folderParts = targetFolder.split("/").filter(Boolean);
    const classification = {
      kind: "本地目录", name: folderParts.at(-1) || targetFolder || "根目录", folder: targetFolder,
      root_folder: folderParts[0] || "", child_folders: folderParts.slice(1), conversation_name: archive.title || change.title || "未命名对话",
      file_title: archive.title || change.title || "未命名对话", prefix: "", field: "", rule_id: null,
      matched_alias: false, source: "manual-folder-direct",
    };
    const oldEntry = {
      ...(existingEntry || {}),
      conversation_id: id,
      json_path: jsonSource || existingEntry?.json_path || "",
      markdown_path: currentPathForRepresentation(change, "markdown") || existingEntry?.markdown_path || "",
    };
    const staged = await stageConversationWrite295({ root, freshArchive: { ...archive, classification, exporter_version: VERSION }, oldEntry });
    if (staged.kind !== "staged") throw new Error(`源原始档案无法安全读取，已写入恢复区：${staged.recovery_path}`);
    index.conversations[id] = indexEntryFromArchive295(staged.archive, staged.plan);
    await persistIndexes(root, index);
    staged.pending.stage = "index_written";
    await writeJson(root, staged.pending_path, staged.pending);
    const finalized = await finalizeConversationWrite295(root, staged, index);
    if (!finalized.complete) throw new Error(`提交校验失败：${finalized.errors.join("；")}`);
    classificationOverrides[id] = { rule_id: null, folder: targetFolder, source: "manual-folder-direct", updated_at: new Date().toISOString() };
    await writeSharedClassificationRules(root);
    const state = await loadConversationState(root);
    state.conversations[id] = stateEntryFromIndexEntry(index.conversations[id], new Date().toISOString());
    await persistConversationState(root, state);
    return {
      conversation_id: id, type: "move",
      raw_path: staged.paths.raw, json_path: staged.paths.json,
      markdown_path: staged.paths.markdown, pdf_path: staged.paths.pdf,
      view_paths: staged.plan.views.map((item) => item.path),
    };
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
    const inventory = await adapter.fetchInventory(session);
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
      try { await walk(await getDirectory(root, auditRootForKind299(kind), false)); }
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
    if (activeTaskRun2983) await attachTaskIo2983(activeTaskRun2983,directory.handle);
    await ensureArchiveStructure(directory.handle);
    await readSharedClassificationRules(directory.handle);
    if (announce) setStatus("正在检查本地文件……", "normal", true);
    let audit = await auditExportFolders(directory.handle, ({ scannedFiles, path }) => {
      if (announce && (scannedFiles === 1 || scannedFiles % 20 === 0)) {
        setStatus(`正在检查：${scannedFiles} 个文件\n${path}`, "normal", true);
      }
      if (activeTaskRun2983 && (scannedFiles === 1 || scannedFiles % 20 === 0)) {
        taskEvent2983(activeTaskRun2983,{type:"folder_scan_progress",stage:"folder-scan",status:"processing",position:scannedFiles,object_type:"file",object_id:String(path || scannedFiles),name:path || null});
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
      directory.handle, preview.ids, latestRule, organizerIssuesFromAudit295(ui._folderAudit),
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

  async function readUserConfigConflictManifest2984(root) {
    if (!root) return {schema_version:"1.0",updated_at:null,conflicts:[]};
    try {
      const value=await readJson(root,USER_CONFIG_CONFLICT_MANIFEST_2984);
      return value && Array.isArray(value.conflicts) ? value : {schema_version:"1.0",updated_at:null,conflicts:[]};
    } catch {
      return {schema_version:"1.0",updated_at:null,conflicts:[]};
    }
  }

  function renderUserConfigConflicts2984(manifest = ui?._userConfigConflictManifest) {
    if (!ui) return;
    const counts=userConfigConflictCounts2984(manifest || {});
    if (ui.userConfigConflictButton) ui.userConfigConflictButton.hidden=counts.pending===0;
    if (ui.userConfigConflictCount) ui.userConfigConflictCount.textContent=`${counts.pending} 项`;
    if (!ui.userConfigConflictList) return;
    const rows=(manifest?.conflicts || []).filter((item)=>item?.status === "pending");
    ui.userConfigConflictList.innerHTML=rows.length ? rows.map((item)=>{
      const alternativesHtml=(item.alternatives || []).map((alt,alternativeIndex)=>`<div class="candidate-row" style="margin-top:8px"><div><strong>历史版本 ${alternativeIndex + 1}</strong><span>备份：${escapeHtml(alt.backup_path || alt.source_path || "已保留")}</span><span>来源：${escapeHtml(alt.source_path || "未知")}</span></div><div class="row-actions"><button class="btn-primary" data-action="config-conflict-use-alternate" data-conflict-id="${escapeHtml(item.conflict_id)}" data-alternative-index="${alternativeIndex}">改用这个历史版本</button></div></div>`).join("");
      return `<div class="candidate-row"><div><strong>分类规则有历史版本待确认</strong><span>当前继续生效：${escapeHtml(item.active_path || SHARED_RULES_PATH)}</span><span>这不会阻止 Conversation 保存；在你确认前不会自动替换当前规则。</span></div><div class="row-actions"><button data-action="config-conflict-keep-current" data-conflict-id="${escapeHtml(item.conflict_id)}">保持当前规则</button></div></div>${alternativesHtml}`;
    }).join("") : '<div class="empty-state"><strong>没有待确认的用户配置</strong><span>你的分类规则没有未处理的版本冲突。</span></div>';
  }

  async function refreshUserConfigConflicts2984({ interactive = false } = {}) {
    const directory=await getAuthorizedDirectory(interactive);
    if (!directory.handle) return null;
    const manifest=await readUserConfigConflictManifest2984(directory.handle);
    ui._userConfigConflictManifest=manifest;
    renderUserConfigConflicts2984(manifest);
    updateManageHomeSummary(ui?._folderAudit);
    return manifest;
  }

  async function resolveUserConfigConflict2984(conflictId, decision, alternativeIndex = 0) {
    const directory=await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason || "未获得资料库目录");
    const manifest=await readUserConfigConflictManifest2984(directory.handle);
    const conflict=(manifest.conflicts || []).find((item)=>String(item?.conflict_id || "") === String(conflictId || ""));
    if (!conflict || conflict.status !== "pending") throw new Error("这个用户配置冲突已经处理或不存在");
    if (decision === "use-alternate") {
      const alternative=(conflict.alternatives || [])[Number(alternativeIndex) || 0];
      if (!alternative?.backup_path) throw new Error("历史分类规则备份不存在，不能切换");
      const bytes=await readBytes281(directory.handle,alternative.backup_path);
      if (!bytes) throw new Error("历史分类规则备份无法读取");
      let candidate;
      try { candidate=JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new Error("历史分类规则不是有效 JSON，已保留备份但不会应用"); }
      await readSharedClassificationRules(directory.handle);
      const current=await readJson(directory.handle,SHARED_RULES_PATH) || {};
      const payload=Array.isArray(candidate)
        ? {rules:candidate,conversation_overrides:current.conversation_overrides,ignored_folders:current.ignored_folders,ignored_title_formats:current.ignored_title_formats}
        : {
            rules:Array.isArray(candidate?.rules)?candidate.rules:current.rules,
            conversation_overrides:candidate?.conversation_overrides ?? current.conversation_overrides,
            ignored_folders:candidate?.ignored_folders ?? current.ignored_folders,
            ignored_title_formats:candidate?.ignored_title_formats ?? current.ignored_title_formats,
          };
      const previousRules=classificationRules, previousOverrides={...classificationOverrides}, previousIgnored=[...ignoredFolders], previousIgnoredTitles=[...ignoredRemoteTitleFormats];
      classificationRules=normalizeRules(payload.rules);
      classificationOverrides=normalizeClassificationOverrides(payload.conversation_overrides);
      ignoredFolders=normalizeIgnoredFolders(payload.ignored_folders);
      ignoredRemoteTitleFormats=normalizeIgnoredTitleFormats(payload.ignored_title_formats);
      try { await writeSharedClassificationRules(directory.handle); }
      catch (error) {
        classificationRules=previousRules; classificationOverrides=previousOverrides; ignoredFolders=previousIgnored; ignoredRemoteTitleFormats=previousIgnoredTitles;
        throw error;
      }
      saveClassificationRules(classificationRules);
      conflict.resolution="use-alternate";
      conflict.applied_backup_path=alternative.backup_path;
    } else if (decision === "keep-current") {
      conflict.resolution="keep-current";
    } else throw new Error("不支持的用户配置处理方式");
    conflict.status="resolved";
    conflict.resolved_at=new Date().toISOString();
    manifest.updated_at=conflict.resolved_at;
    await writeJson(directory.handle,USER_CONFIG_CONFLICT_MANIFEST_2984,manifest);
    ui._userConfigConflictManifest=manifest;
    renderUserConfigConflicts2984(manifest);
    renderClassificationRules();
    updateManageHomeSummary(ui?._folderAudit);
    setStatus(decision === "use-alternate" ? `已经切换到你选择的历史分类规则。\n切换前的当前规则已备份到 ${META_DIR}/backups/；如要找回旧规则，从这里取回即可。` : "已经确认继续使用当前分类规则。", "ok");
    return manifest;
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
    await getDirectory(directory.handle, joinPath(JSON_ROOT, targetFolder), true);
    await getDirectory(directory.handle, joinPath(MARKDOWN_ROOT, targetFolder), true);
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

  const CONVERSATION_429_COOLDOWNS_MS = [30000, 60000, 120000, 180000];
  let conversation429Level = 0;
  let conversation429Until = 0;

  function isConversationDetailUrl2985(url) {
    return /^\/(?:backend-api|api)\/conversation\/[^/?#]+(?:[?#].*)?$/.test(String(url || ""));
  }

  function retryAfterMs2985(response) {
    const raw = response?.headers?.get?.("retry-after");
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : 0;
  }

  async function waitForConversation429Cooldown2985(url) {
    if (!isConversationDetailUrl2985(url)) return;
    let remaining = conversation429Until - Date.now();
    if (remaining <= 0) return;
    setStatus(`ChatGPT 正在限速\n已自动等待 ${Math.ceil(remaining / 1000)} 秒后继续保存；已经完成的内容不会重复下载。`, "warning", true);
    while ((remaining = conversation429Until - Date.now()) > 0) {
      if (cancelRequested) throw new Error("用户已取消同步");
      await sleep(Math.min(1000, remaining));
    }
  }

  function noteConversation4292985(response, url) {
    if (!isConversationDetailUrl2985(url) || response?.status !== 429) return 0;
    const fallback = CONVERSATION_429_COOLDOWNS_MS[Math.min(conversation429Level, CONVERSATION_429_COOLDOWNS_MS.length - 1)];
    const delay = Math.max(fallback, retryAfterMs2985(response));
    conversation429Level = Math.min(conversation429Level + 1, CONVERSATION_429_COOLDOWNS_MS.length - 1);
    conversation429Until = Math.max(conversation429Until, Date.now() + delay);
    return delay;
  }

  function resetConversation4292985() {
    conversation429Level = 0;
    conversation429Until = 0;
  }

  async function fetchWithRetry(url, options = {}, retries = 3) {
    let lastError;
    const maxRetries = isConversationDetailUrl2985(url) ? Math.max(retries, 6) : retries;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (cancelRequested) throw new Error("用户已取消同步");
      await waitForConversation429Cooldown2985(url);
      try {
        const response = await fetch(url, options);
        if (response.ok) return response;
        if (![429, 500, 502, 503, 504].includes(response.status)) return response;
        lastError = new Error(`HTTP ${response.status}`);
        if (response.status === 429 && isConversationDetailUrl2985(url)) {
          noteConversation4292985(response, url);
          if (attempt < maxRetries) continue;
        }
      } catch (error) {
        lastError = error;
      }
      if (attempt < maxRetries) await sleep(Math.min(8000, 600 * (2 ** attempt)) + Math.floor(Math.random() * 250));
    }
    throw lastError || new Error("网络请求失败");
  }

  async function getSession() {
    try {
      const response = await fetchWithRetry("/api/auth/session", {
        credentials: "include", headers: { Accept: "application/json" }, cache: "no-store",
      }, 1);
      if (!response.ok) return { ok: false, status: response.status, token: null, credential: null, account_scope: null, workspace_scope: null };
      const data = await response.json();
      const token = data?.accessToken || data?.access_token || null;
      const user = data?.user && typeof data.user === "object" ? {
        id: data.user.id ? String(data.user.id) : null,
        email: data.user.email ? String(data.user.email) : null,
        name: data.user.name ? String(data.user.name) : null,
      } : null;
      return {
        ok: Boolean(data?.user || token),
        status: response.status,
        token,
        credential: token,
        user,
        account_scope: data?.account?.id || data?.account_id || user?.id || user?.email || null,
        workspace_scope: data?.workspace?.id || data?.workspace_id || data?.active_workspace_id || null,
      };
    } catch (error) {
      return { ok: false, status: 0, token: null, credential: null, account_scope: null, workspace_scope: null, error: error.message };
    }
  }

  function authHeaders(context) {
    const headers = { Accept: "application/json" };
    const token = typeof context === "string"
      ? context
      : context?.credential ?? context?.token ?? context?.session?.credential ?? context?.session?.token ?? null;
    if (token) headers.Authorization = `Bearer ${token}`;
    const accountId = typeof context === "object" && context
      ? context?.account_scope ?? context?.session?.account_scope ?? context?.account?.id ?? context?.session?.account?.id ?? null
      : null;
    if (accountId) headers["chatgpt-account-id"] = String(accountId);
    return headers;
  }

  async function fetchConversation(conversationId, context) {
    const errors = [];
    for (const base of ["/backend-api/conversation/", "/api/conversation/"]) {
      const endpoint = `${base}${encodeURIComponent(conversationId)}`;
      try {
        const response = await fetchWithRetry(endpoint, {
          credentials: "include", headers: authHeaders(context), cache: "no-store",
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

  async function fetchCompleteInventory(context) {
    const token = typeof context === "string" ? context : context?.token || context?.credential || null;
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
    const ordinary = new Map();
    for (const item of normal.items.map((x) => normalizeInventoryItem(x, false))) if (item.id) ordinary.set(item.id, item);
    for (const item of archived.items.map((x) => normalizeInventoryItem(x, true))) if (item.id) ordinary.set(item.id, item);

    // 2.9.5 only adds a side inventory for Projects. Failure is isolated and never changes the ordinary/archived pagination contract.
    const projects = await V295.collectProjectInventorySafe({
      fetchImpl: (url, options) => fetchWithRetry(url, options, 2),
      headers: authHeaders(context),
    });
    const merged = V295.mergeInventoryWithProjects([...ordinary.values()], projects.rows);
    return { items: merged.items, normal, archived, archivedBoundary, projects };
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

  async function showDirectoryPickerSafe(options = {}) {
    if (typeof window.showDirectoryPicker !== "function") throw new Error("当前浏览器不支持 File System Access API（showDirectoryPicker）");
    const primary = { ...options };
    try {
      return await window.showDirectoryPicker(primary);
    } catch (error) {
      if (error?.name !== "TypeError" || !Object.prototype.hasOwnProperty.call(primary, "id")) throw error;
      const fallback = { ...primary };
      delete fallback.id;
      return window.showDirectoryPicker(fallback);
    }
  }

  async function chooseDirectory() {
    if (typeof window.showDirectoryPicker !== "function") throw new Error("当前浏览器不支持 File System Access API（showDirectoryPicker）");
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "chatgpt-local-export-root" });
    if (!(await verifyPermission(handle, true))) throw new Error("未获得导出目录读写权限");
    await idbSetHandle(handle);
    cachedDirectoryHandle = handle;
    directoryHandleLoaded = true;
    updateDirectoryDisplay();
    await maybePromptLibraryUpgrade281(handle);
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

  async function readBytes281(root, path) {
    try {
      const handle = await getFileHandle(root, path, false);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (error) {
      if (error?.name === "NotFoundError") return null;
      throw error;
    }
  }

  async function sha256Hex281(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function fileExists281(root, path) {
    try { await getFileHandle(root, path, false); return true; }
    catch (error) { if (error?.name === "NotFoundError") return false; throw error; }
  }

  async function directoryExists281(root, path) {
    try { await getDirectory(root, path, false); return true; }
    catch (error) { if (error?.name === "NotFoundError") return false; throw error; }
  }

  async function directoryContainsAnyFile281(root, path) {
    try {
      const dir = await getDirectory(root, path, false);
      for await (const entry of walkDirectory(dir)) { if (entry?.handle?.kind === "file") return true; }
      return false;
    } catch (error) { if (error?.name === "NotFoundError") return false; throw error; }
  }

  async function loadAnyIndex281(root) {
    const candidates = [
      `${META_DIR}/index.json`, `${LEGACY_META_DIR}/index.json`,
      PUBLIC_INDEX_PATH, "conversation-index.json",
    ];
    for (const path of candidates) {
      try {
        const value = await readJson(root, path);
        if (value?.conversations && typeof value.conversations === "object") return { index:value, path };
      } catch { /* damaged index is not proof that user files are plugin assets */ }
    }
    return { index:null, path:"" };
  }

  async function probeLibraryUpgrade281(root) {
    if (!root) return { hasPluginEvidence:false, receiptComplete:false, sourceVersion:"", conversationCount:0, root:null };
    let receipt = null, staging = null;
    try { receipt = await readJson(root, LIBRARY_UPGRADE_RECEIPT_PATH); } catch { receipt = null; }
    try { staging = await readJson(root, LIBRARY_UPGRADE_STAGING_PATH); } catch { staging = null; }
    const loaded = await loadAnyIndex281(root);
    const legacyRoots = ["原始","JSON","Markdown","PDF","项目","归档","已删除",LEGACY_ARCHIVE_FOLDER,LEGACY_DELETED_FOLDER,LEGACY_META_DIR];
    let hasMarker = Boolean(loaded.index);
    if (!hasMarker) {
      for (const path of legacyRoots) {
        if (await directoryExists281(root, path)) { hasMarker = true; break; }
      }
    }
    if (!hasMarker) {
      for (const path of [RAW_ROOT,JSON_ROOT,MARKDOWN_ROOT,PDF_ROOT,PROJECT_ROOT,SYSTEM_ARCHIVE_FOLDER,SYSTEM_DELETED_FOLDER]) {
        if (await directoryContainsAnyFile281(root, path)) { hasMarker = true; break; }
      }
    }
    const sourceVersion = String(loaded.index?.exporter_version || loaded.index?.tool_version || "");
    const interrupted = Boolean(staging && staging.complete !== true);
    const receiptLayoutVersion = receipt?.library_layout_version
      || (receipt?.complete === true && String(receipt?.schema_version || "") === "1.0" ? LIBRARY_LAYOUT_VERSION_2983 : null);
    const receiptComplete = Boolean(
      (receipt?.complete === true && receiptLayoutVersion === LIBRARY_LAYOUT_VERSION_2983)
      || (sourceVersion === VERSION && !interrupted)
    );
    return {
      root,
      hasPluginEvidence:hasMarker,
      receiptComplete,
      receipt,
      staging,
      sourceVersion,
      conversationCount:Object.keys(loaded.index?.conversations || {}).length,
      index:loaded.index,
      indexPath:loaded.path,
    };
  }

  async function libraryFingerprint281(root, index = null) {
    const loaded = index ? { index } : await loadAnyIndex281(root);
    const value = loaded.index || index || {};
    const ids = Object.keys(value?.conversations || {}).sort();
    const material = JSON.stringify({ root_name:String(root?.name || ""), exporter_version:String(value?.exporter_version || ""), updated_at:String(value?.updated_at || ""), ids });
    return sha256Hex281(new TextEncoder().encode(material));
  }

  async function addManagedAsset281(root, map, sourcePath, type = "plugin") {
    const source = normalizeStatePath(sourcePath || "");
    if (!source || map.has(source) || !(await fileExists281(root, source))) return;
    map.set(source, { source_path:source, target_path:mapLegacyLibraryPath299(source) || source, asset_type:type });
  }

  function siblingPdfPath281(markdownPath) {
    const path = normalizeStatePath(markdownPath || "");
    if (!/\.md$/i.test(path)) return "";
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (["Markdown",MARKDOWN_ROOT].includes(parts[i])) { parts[i] = parts[i] === "Markdown" ? "PDF" : PDF_ROOT; break; }
    }
    return parts.join("/").replace(/\.md$/i, ".pdf");
  }

  async function collectDynamicMetaAssets281(root, map, base) {
    const allowed = ["pending","recovery","backups","migrations","extraction-history"];
    for (const child of allowed) {
      let dir;
      try { dir = await getDirectory(root, joinPath(base, child), false); }
      catch (error) { if (error?.name === "NotFoundError") continue; throw error; }
      for await (const entry of walkDirectory(dir)) {
        if (!/\.(?:json|md)$/i.test(entry.path)) continue;
        await addManagedAsset281(root, map, joinPath(base, child, entry.path), "engineering");
      }
    }
  }

  async function collectExtractionHistoryAssets281(root, map, metaBase, historyBase) {
    let metaDir;
    try { metaDir = await getDirectory(root, joinPath(metaBase, "extraction-history"), false); }
    catch (error) { if (error?.name === "NotFoundError") return; throw error; }
    for await (const [name, handle] of metaDir.entries()) {
      if (handle.kind !== "file" || !/\.json$/i.test(name)) continue;
      const metaPath = joinPath(metaBase, "extraction-history", name);
      await addManagedAsset281(root, map, metaPath, "extraction-meta");
      let manifest = null;
      try { manifest = JSON.parse(await (await handle.getFile()).text()); } catch { continue; }
      const historyName = name.replace(/\.json$/i, "");
      if (manifest?.output === "zip") {
        await addManagedAsset281(root, map, joinPath(historyBase, `${historyName}.zip`), "extraction-history");
        continue;
      }
      for (const item of Array.isArray(manifest?.conversations) ? manifest.conversations : []) {
        for (const key of ["raw_path","json_path","markdown_path","pdf_path","word_path"]) {
          const rel = normalizeStatePath(item?.[key] || "");
          if (rel) await addManagedAsset281(root, map, joinPath(historyBase, historyName, rel), "extraction-history");
        }
      }
    }
  }

  async function collectUserConfigConflictBackups2984(root, map) {
    let dir;
    try { dir=await getDirectory(root,USER_CONFIG_CONFLICT_ROOT_2984,false); }
    catch (error) { if (error?.name === "NotFoundError") return; throw error; }
    for await (const entry of walkDirectory(dir)) {
      if (entry?.handle?.kind !== "file") continue;
      await addManagedAsset281(root,map,joinPath(USER_CONFIG_CONFLICT_ROOT_2984,entry.path),"user-config-backup");
    }
  }

  async function scanProvenConversationAssets281(root, map, knownShortIds = new Set()) {
    const roots = ["原始","JSON","Markdown","PDF","项目","归档","已删除",RAW_ROOT,JSON_ROOT,MARKDOWN_ROOT,PDF_ROOT,PROJECT_ROOT,SYSTEM_ARCHIVE_FOLDER,SYSTEM_DELETED_FOLDER];
    for (const base of roots) {
      let dir;
      try { dir = await getDirectory(root, base, false); }
      catch (error) { if (error?.name === "NotFoundError") continue; throw error; }
      for await (const entry of walkDirectory(dir)) {
        const path = joinPath(base, entry.path);
        const filename = path.split("/").pop() || "";
        const suffix = filename.match(/__([A-Za-z0-9_-]{4,})\.(?:json|md|pdf)$/i)?.[1] || "";
        if (suffix && knownShortIds.has(suffix)) {
          await addManagedAsset281(root, map, path, /\.pdf$/i.test(path) ? "conversation-pdf" : "conversation");
          continue;
        }
        if (/\.json$/i.test(path)) {
          try {
            const data = JSON.parse(await (await entry.handle.getFile()).text());
            if (data?.conversation_id && (data?.exporter_version || data?.schema_version || data?.raw?.mapping || Array.isArray(data?.messages))) await addManagedAsset281(root, map, path, "conversation");
          } catch { /* user JSON stays outside ownership */ }
        } else if (/\.md$/i.test(path)) {
          try {
            const text = await (await entry.handle.getFile()).text();
            if (/^---\s*[\s\S]{0,5000}?conversation_id\s*:/i.test(text) && /exporter_version\s*:/i.test(text)) {
              await addManagedAsset281(root, map, path, "conversation");
              const pdf = siblingPdfPath281(path);
              if (pdf) await addManagedAsset281(root, map, pdf, "conversation-pdf");
            }
          } catch { /* user Markdown stays outside ownership */ }
        }
      }
    }
  }

  async function collectProvenManagedAssets281(root) {
    const map = new Map();
    const loaded = await loadAnyIndex281(root);
    const indexes = [`${META_DIR}/index.json`,`${LEGACY_META_DIR}/index.json`,PUBLIC_INDEX_PATH,"conversation-index.json"];
    for (const path of indexes) await addManagedAsset281(root, map, path, "index");
    try {
      const priorLedger = await readJson(root, ASSET_LEDGER_PATH);
      await addManagedAsset281(root, map, ASSET_LEDGER_PATH, "asset-ledger");
      for (const asset of Array.isArray(priorLedger?.assets) ? priorLedger.assets : []) await addManagedAsset281(root, map, asset?.path, asset?.asset_type || "ledger-owned");
    } catch { /* no prior ledger on old versions */ }
    const index = loaded.index;
    for (const entry of Object.values(index?.conversations || {})) {
      const paths = [entry?.raw_path,entry?.json_path,entry?.markdown_path,entry?.pdf_path,...(Array.isArray(entry?.view_paths)?entry.view_paths:[]),...(Array.isArray(entry?.project_views)?entry.project_views.map((view)=>view?.path):[])];
      for (const path of paths) await addManagedAsset281(root, map, path, managedConversationAssetType2984(path));
      const pdf = siblingPdfPath281(entry?.markdown_path);
      if (pdf) await addManagedAsset281(root, map, pdf, "conversation-pdf");
    }
    const stateCandidates = [
      CHANGE_MANIFEST_PATH,SHARED_RULES_PATH,USER_CONFIG_CONFLICT_MANIFEST_2984,CONVERSATION_STATE_PATH,DELETED_CONVERSATIONS_PATH,FOLDER_STATE_PATH,
      `${META_DIR}/sync-history.json`,`${META_DIR}/last-report.md`,VIEW_MIGRATION_STATE_PATH,
      `${LEGACY_META_DIR}/conversation-changes.json`,`${LEGACY_META_DIR}/classification-rules.json`,
      `${LEGACY_META_DIR}/conversation-state.json`,`${LEGACY_META_DIR}/deleted-conversations.json`,
      `${LEGACY_META_DIR}/folder-state.json`,`${LEGACY_META_DIR}/sync-history.json`,`${LEGACY_META_DIR}/last-report.md`,
      TIMELINE_PATH,"timeline.json",
    ];
    for (const path of stateCandidates) {
      const normalized=normalizeStatePath(path);
      if (normalized === normalizeStatePath(SHARED_RULES_PATH) || normalized === normalizeStatePath(`${LEGACY_META_DIR}/classification-rules.json`)) {
        await addManagedAsset281(root, map, path, "user-config");
      } else {
        await addManagedAsset281(root, map, path, "engineering");
      }
    }
    for (const statePath of [CONVERSATION_STATE_PATH,DELETED_CONVERSATIONS_PATH,`${LEGACY_META_DIR}/conversation-state.json`,`${LEGACY_META_DIR}/deleted-conversations.json`]) {
      try {
        const state = await readJson(root, statePath);
        const containers = [state?.conversations,state?.deleted];
        for (const container of containers) for (const item of Object.values(container || {})) {
          for (const path of [item?.last_known?.json_path,item?.last_known?.markdown_path,item?.json_path,item?.markdown_path]) await addManagedAsset281(root, map, path, "conversation-state");
        }
      } catch { /* invalid state is not used as ownership evidence */ }
    }
    await collectDynamicMetaAssets281(root, map, META_DIR);
    await collectDynamicMetaAssets281(root, map, LEGACY_META_DIR);
    await collectExtractionHistoryAssets281(root, map, META_DIR, EXTRACTION_HISTORY_FOLDER);
    await collectExtractionHistoryAssets281(root, map, LEGACY_META_DIR, "提取历史");
    await collectUserConfigConflictBackups2984(root,map);
    const knownShortIds = new Set(Object.keys(index?.conversations || {}).map((id)=>shortId(id)));
    await scanProvenConversationAssets281(root, map, knownShortIds);
    map.delete(normalizeStatePath(LIBRARY_UPGRADE_STAGING_PATH));
    map.delete(normalizeStatePath(LIBRARY_UPGRADE_RECEIPT_PATH));
    map.delete(normalizeStatePath(ASSET_LEDGER_PATH));
    return { assets:[...map.values()].sort((a,b)=>a.source_path.localeCompare(b.source_path,"zh-CN")), index };
  }

  function managedAssetIo281(sourceRoot, targetRoot) {
    return {
      readSource:(path)=>readBytes281(sourceRoot,path),
      readTarget:(path)=>readBytes281(targetRoot,path),
      writeTarget:(path,bytes)=>writeBinary(targetRoot,path,bytes),
      removeSource:async(path)=>{ await removeFile(sourceRoot,path); try { await removeEmptyAncestorDirectories(sourceRoot,path); } catch { /* keep non-empty/user directories */ } },
      hashBytes:sha256Hex281,
    };
  }

  async function directoryHasEntries281(root) {
    for await (const _entry of root.values()) return true;
    return false;
  }

  async function ensureNumberedStructure281(root) {
    for (const path of [
      `${RAW_ROOT}/${SYSTEM_INBOX_FOLDER}`,
      `${JSON_ROOT}/${SYSTEM_INBOX_FOLDER}`,
      `${MARKDOWN_ROOT}/${SYSTEM_INBOX_FOLDER}`,
      `${PDF_ROOT}/${SYSTEM_INBOX_FOLDER}`,
      PROJECT_ROOT,
      `${SYSTEM_ARCHIVE_FOLDER}/${RAW_ROOT}`, `${SYSTEM_ARCHIVE_FOLDER}/${JSON_ROOT}`, `${SYSTEM_ARCHIVE_FOLDER}/${MARKDOWN_ROOT}`, `${SYSTEM_ARCHIVE_FOLDER}/${PDF_ROOT}`,
      `${SYSTEM_DELETED_FOLDER}/${RAW_ROOT}`, `${SYSTEM_DELETED_FOLDER}/${JSON_ROOT}`, `${SYSTEM_DELETED_FOLDER}/${MARKDOWN_ROOT}`, `${SYSTEM_DELETED_FOLDER}/${PDF_ROOT}`,
      EXTRACTION_HISTORY_FOLDER,
      META_DIR,
    ]) await getDirectory(root, path, true);
  }

  async function cleanupEmptyLegacyRoots281(root) {
    const removed = [];
    for (const name of ["原始","JSON","Markdown","PDF","项目","归档",LEGACY_ARCHIVE_FOLDER,"已删除",LEGACY_DELETED_FOLDER,LEGACY_META_DIR]) {
      try { await root.removeEntry(name,{recursive:false}); removed.push(name); }
      catch (error) { if (!["NotFoundError","InvalidModificationError","NoModificationAllowedError"].includes(error?.name)) console.warn(`旧目录 ${name} 未清理`,error); }
    }
    return removed;
  }

  async function validateMigratedLibrary281(sourceIndex, targetRoot) {
    if (!sourceIndex?.conversations) return { ok:true, sourceCount:0, targetCount:0, missing:[] };
    const target = await loadIndex(targetRoot);
    if (!target?.conversations) return { ok:false, sourceCount:Object.keys(sourceIndex.conversations).length, targetCount:0, missing:Object.keys(sourceIndex.conversations) };
    const sourceIds = Object.keys(sourceIndex.conversations);
    const missing = sourceIds.filter((id)=>!target.conversations[id]);
    return { ok:missing.length===0, sourceCount:sourceIds.length, targetCount:Object.keys(target.conversations).length, missing };
  }

  function updateUpgradeProgress281(text, kind = "normal") {
    if (ui?.upgradeProgress) { ui.upgradeProgress.textContent = text; ui.upgradeProgress.dataset.kind = kind; }
    setStatus(text, kind, true);
  }

  async function persistUserConfigConflicts2984(root, copyResult) {
    const detected=userConfigConflictsFromMigration2984(copyResult);
    if (!detected.length) return null;
    let previous=null;
    try { previous=await readJson(root,USER_CONFIG_CONFLICT_MANIFEST_2984); } catch { previous=null; }
    const existing=new Map((Array.isArray(previous?.conflicts)?previous.conflicts:[]).map((item)=>[String(item?.conflict_id || ""),item]));
    const merged=[];
    for (const item of detected) {
      const prior=existing.get(item.conflict_id);
      merged.push(prior?.status === "resolved" ? prior : item);
      existing.delete(item.conflict_id);
    }
    for (const item of existing.values()) merged.push(item);
    const value={schema_version:"1.0",updated_at:new Date().toISOString(),conflicts:merged};
    await writeJson(root,USER_CONFIG_CONFLICT_MANIFEST_2984,value);
    return value;
  }

  async function writeUpgradeReceipt281(root, mode, sourceFingerprint, copyResult, validation, sourceName) {
    const ledgerByPath = new Map();
    for (const item of copyResult.records.filter((entry)=>String(entry.status || "").startsWith("verified"))) {
      const path = normalizeStatePath(item.target_path || "");
      if (!path) continue;
      const finalBytes = await readBytes281(root,path);
      if (!finalBytes) continue;
      ledgerByPath.set(path, {
        path, source_path:item.source_path, asset_type:item.asset_type || "plugin",
        source_sha256:item.sha256 || "", sha256:await sha256Hex281(finalBytes),
      });
    }
    const ledger = {
      schema_version:"1.0", owner:"AI 对话流转", generated_at:new Date().toISOString(), migration_version:VERSION,
      assets:[...ledgerByPath.values()].sort((a,b)=>a.path.localeCompare(b.path,"zh-CN")),
    };
    await writeJson(root, ASSET_LEDGER_PATH, ledger);
    await persistUserConfigConflicts2984(root, copyResult);
    // Layout migration only copies verified assets. It must not claim that copied
    // Markdown/PDF views were freshly rendered by this app version. The next
    // full save will compare VIEW_RENDER_VERSION_2983 and rebuild views once if needed.
    await writeJson(root, LIBRARY_UPGRADE_RECEIPT_PATH, {
      schema_version:"1.0", library_layout_version:LIBRARY_LAYOUT_VERSION_2983, target_version:VERSION, complete:true, mode, source_name:String(sourceName || ""), source_fingerprint:sourceFingerprint,
      completed_at:new Date().toISOString(), total:copyResult.total, verified:copyResult.verified, validation,
    });
    try { await removeFile(root, LIBRARY_UPGRADE_STAGING_PATH); } catch (error) { if (error?.name !== "NotFoundError") throw error; }
  }

  async function persistUpgradeConflictState2983(root, staging, copyResult, { mode = "new-directory", sourceFingerprint = "", sourceName = "" } = {}) {
    const conflicts=(copyResult?.records || []).filter((item)=>String(item?.status || "").startsWith("conflict"));
    const value={
      ...(staging && typeof staging === "object" ? staging : {}),
      schema_version:"1.1", complete:false, mode, source_fingerprint:sourceFingerprint || staging?.source_fingerprint || "", source_name:String(sourceName || staging?.source_name || ""),
      started_at:staging?.started_at || new Date().toISOString(), updated_at:new Date().toISOString(),
      resolutions:staging?.resolutions && typeof staging.resolutions === "object" ? staging.resolutions : {},
      last_result:{ total:Number(copyResult?.total || 0), source_total:Number(copyResult?.source_total || 0), verified:Number(copyResult?.verified || 0), failed:Number(copyResult?.failed || 0), conflicts:Number(copyResult?.conflicts || 0), deduplicated:Number(copyResult?.deduplicated || 0) },
      conflicts:conflicts.map((item)=>({target_path:item.target_path || null,status:item.status || "conflict",error_code:item.error_code || (item.status === "conflict-target-existing" ? "migration_target_content_conflict" : "duplicate_target_divergent_sources"),existing_sha256:item.existing_sha256 || null,candidates:Array.isArray(item.candidates)?item.candidates:[]})),
    };
    await writeJson(root,LIBRARY_UPGRADE_STAGING_PATH,value);
    return value;
  }

  function clearUpgradeConflicts2983() {
    if (ui?.upgradeConflicts) { ui.upgradeConflicts.innerHTML=""; ui.upgradeConflicts.hidden=true; }
    if (ui) ui._upgradeConflictContext=null;
  }

  function renderUpgradeConflicts2983(conflicts = [], context = null) {
    if (!ui?.upgradeConflicts) return;
    ui._upgradeConflictContext=context || null;
    ui.upgradeConflicts.innerHTML="";
    const rows=Array.isArray(conflicts)?conflicts:[];
    ui.upgradeConflicts.hidden=rows.length===0;
    for (const conflict of rows) {
      const card=document.createElement("div"); card.className="upgrade-conflict-item";
      const title=document.createElement("strong"); title.textContent=`冲突：${conflict.target_path || "未知目标"}`; card.appendChild(title);
      const detail=document.createElement("div"); detail.className="upgrade-conflict-detail";
      const candidates=Array.isArray(conflict.candidates)?conflict.candidates:[];
      detail.textContent=candidates.length ? candidates.map((item,index)=>`${index+1}. ${item.source_path || "未知来源"}\nSHA256: ${item.sha256 || "未知"}`).join("\n\n") : `目标位置已有不同内容\n现有 SHA256: ${conflict.existing_sha256 || "未知"}`;
      card.appendChild(detail);
      const actions=document.createElement("div"); actions.className="upgrade-conflict-actions";
      for (const candidate of candidates) {
        const button=document.createElement("button");
        const current=candidate.origin === "target" || candidate.source_path===conflict.target_path;
        button.textContent=current ? "保留新版位置这个版本" : `保留这个旧版来源`;
        button.dataset.action="upgrade-resolve-conflict";
        button.dataset.targetPath=conflict.target_path || "";
        button.dataset.decision=current ? "keep-current" : "keep-legacy";
        button.dataset.sourcePath=candidate.source_path || "";
        actions.appendChild(button);
      }
      if (candidates.length>1) {
        const both=document.createElement("button"); both.textContent="两份都保留"; both.dataset.action="upgrade-resolve-conflict"; both.dataset.targetPath=conflict.target_path || ""; both.dataset.decision="keep-both"; both.dataset.sourcePath=(candidates.find((item)=>item.source_path===conflict.target_path)||candidates[0])?.source_path || ""; actions.appendChild(both);
      }
      card.appendChild(actions); ui.upgradeConflicts.appendChild(card);
    }
  }

  async function applyUpgradeConflictResolution2983(targetPath, decision, sourcePath = "") {
    const context=ui?._upgradeConflictContext;
    if (!context?.targetHandle || !context?.sourceRoot) throw new Error("当前没有可以继续处理的资料库迁移冲突；请重新选择升级目录以恢复任务");
    const staging=await readJson(context.targetHandle,LIBRARY_UPGRADE_STAGING_PATH).catch(()=>null);
    if (!staging || !canResumeUpgradeTarget281(staging,context.sourceFingerprint)) throw new Error("这次迁移的恢复状态已经失效；请重新开始资料库升级");
    const normalizedDecision=String(decision || "");
    if (!["keep-current","keep-legacy","keep-both"].includes(normalizedDecision)) throw new Error("不支持的冲突处理方式");
    const resolutions={...(staging.resolutions || {}),[String(targetPath || "")]:{decision:normalizedDecision,source_path:String(sourcePath || ""),decided_at:new Date().toISOString()}};
    await writeJson(context.targetHandle,LIBRARY_UPGRADE_STAGING_PATH,{...staging,resolutions,updated_at:new Date().toISOString()});
    if (activeTaskRun2983) taskEvent2983(activeTaskRun2983,{type:"migration_conflict_resolution",stage:"resolve",status:"resolved",object_type:"asset",object_id:String(targetPath || ""),target_path:String(targetPath || ""),decision:normalizedDecision,source_path:String(sourcePath || "")});
    if (context.mode === "in-place") return runInPlaceUpgrade281(context.sourceRoot,{skipConfirm:true});
    return runNewDirectoryUpgrade281(context.sourceRoot,{targetHandle:context.targetHandle});
  }

  async function runNewDirectoryUpgrade281(sourceRoot, { targetHandle: providedTarget = null } = {}) {
    if (!sourceRoot) throw new Error("找不到旧资料库");
    if (!providedTarget && typeof window.showDirectoryPicker !== "function") throw new Error("当前浏览器不支持选择新资料库目录");
    const targetHandle = providedTarget || await showDirectoryPickerSafe({ mode:"readwrite", id:"aicf-upgrade-target" });
    if (!(await verifyPermission(targetHandle,true))) throw new Error("未获得新资料库目录读写权限");
    if (typeof sourceRoot.isSameEntry === "function" && await sourceRoot.isSameEntry(targetHandle)) throw new Error("新资料库不能选择旧资料库本身；如果想原地调整，请选择“当前目录原地升级”");
    const source = await loadAnyIndex281(sourceRoot);
    const sourceFingerprint = await libraryFingerprint281(sourceRoot, source.index);
    const staging = await readJson(targetHandle, LIBRARY_UPGRADE_STAGING_PATH).catch(()=>null);
    const nonEmpty = await directoryHasEntries281(targetHandle);
    if (nonEmpty && !canResumeUpgradeTarget281(staging, sourceFingerprint)) throw new Error("请选择一个空文件夹；这个目标目录已有其他内容，为避免混入用户文件，已停止迁移");
    if (activeTaskRun2983) await attachTaskIo2983(activeTaskRun2983,targetHandle);
    await ensureNumberedStructure281(targetHandle);
    const stagingBase=canResumeUpgradeTarget281(staging,sourceFingerprint)
      ? {...staging,updated_at:new Date().toISOString(),mode:"new-directory"}
      : { schema_version:"1.1", complete:false, source_fingerprint:sourceFingerprint, source_name:String(sourceRoot.name || ""), started_at:new Date().toISOString(), updated_at:new Date().toISOString(), mode:"new-directory", resolutions:{} };
    await writeJson(targetHandle, LIBRARY_UPGRADE_STAGING_PATH, stagingBase);
    const collected = await collectProvenManagedAssets281(sourceRoot);
    if (!collected.assets.length) throw new Error("没有识别到可以证明由插件创建的资产；为避免把用户文件误当插件数据，本次没有切换资料库");
    if (activeTaskRun2983) taskEvent2983(activeTaskRun2983,{type:"migration_inventory",stage:"inventory",status:"complete",managed_asset_count:collected.assets.length,source_library:String(sourceRoot.name || ""),target_library:String(targetHandle.name || "")});
    updateUpgradeProgress281(`已识别 ${collected.assets.length} 个插件管理资产；开始复制到新目录。\n旧资料库保持只读，不删除任何文件。`);
    const copyResult = await copyManagedAssetManifest281(collected.assets, managedAssetIo281(sourceRoot,targetHandle), { inPlace:false, resolutions:stagingBase.resolutions || {}, taskRun:activeTaskRun2983, progress:({position,total,target_path})=>updateUpgradeProgress281(`正在迁移 ${position}/${total}\n${target_path}\n旧资料库不会被修改或删除。`) });
    if (!copyResult.complete) {
      try { await persistUserConfigConflicts2984(targetHandle, copyResult); } catch (error) { console.warn?.("用户配置冲突清单登记失败", error); }
      const persisted=await persistUpgradeConflictState2983(targetHandle,stagingBase,copyResult,{mode:"new-directory",sourceFingerprint,sourceName:sourceRoot.name});
      const conflictRows=persisted.conflicts || [];
      renderUpgradeConflicts2983(conflictRows,{mode:"new-directory",sourceRoot,targetHandle,sourceFingerprint});
      updateUpgradeProgress281(`资料库迁移尚未完成\n成功 ${copyResult.verified}/${copyResult.total}｜失败 ${copyResult.failed}｜冲突 ${copyResult.conflicts}\n${copyResult.conflicts ? "请在下面选择冲突版本，处理后会继续迁移。" : "请查看任务日志中的失败对象。"}`,"warning");
      const error=new Error(`迁移没有通过完整校验：成功 ${copyResult.verified}/${copyResult.total}，失败 ${copyResult.failed}，冲突 ${copyResult.conflicts}。旧资料库未改动。`);
      error.code=copyResult.conflicts ? "LIBRARY_UPGRADE_CONFLICT" : "LIBRARY_UPGRADE_FAILED";
      throw error;
    }
    clearUpgradeConflicts2983();
    await remapLayoutMetadata299(targetHandle);
    const validation = await validateMigratedLibrary281(collected.index,targetHandle);
    const commitCandidate = { ...copyResult, complete:copyResult.complete && validation.ok };
    if (!canCommitLibraryUpgrade281(commitCandidate)) throw new Error(`新资料库校验没有通过；缺少 ${validation.missing.length} 个 Conversation。旧资料库仍然是当前资料库。`);
    await writeUpgradeReceipt281(targetHandle,"new-directory",sourceFingerprint,copyResult,validation,sourceRoot.name);
    if (activeTaskRun2983) {
      await writeTaskCheckpoint2983(activeTaskRun2983,{phase:"complete",position:copyResult.total,total:copyResult.total,resume_supported:false,target_library:String(targetHandle.name || "")});
      taskEvent2983(activeTaskRun2983,{type:"migration_commit",stage:"commit",status:"complete",critical:true,verified:copyResult.verified,total:copyResult.total,deduplicated:copyResult.deduplicated || 0});
    }
    await idbSetHandle(targetHandle);
    cachedDirectoryHandle = targetHandle;
    directoryHandleLoaded = true;
    if (ui) { ui._folderAudit = null; ui._extractCandidates = null; ui._extractCatalogEntries = null; ui._extractIndex = null; ui._extractSelectedIds = new Set(); ui._extractDirty = true; }
    updateDirectoryDisplay();
    hideLibraryUpgradeWizard281();
    setStatus(`新版资料库已创建\n迁移并校验 ${copyResult.verified} 个目标资产${copyResult.deduplicated ? `，自动合并 ${copyResult.deduplicated} 组历史重复源` : ""}。\n旧资料库“${sourceRoot.name || "旧资料库"}”没有被修改或删除。`,"ok");
    return { targetHandle, copyResult, validation };
  }

  async function runInPlaceUpgrade281(sourceRoot, { skipConfirm = false } = {}) {
    if (!sourceRoot) throw new Error("找不到当前资料库");
    if (!skipConfirm && !window.confirm("原地升级会调整插件自己生成的文件位置。\n\n插件无法证明属于自己的文件不会移动或删除；如果你曾手动往资料库里放过其他内容，仍然建议先备份。\n\n继续原地升级？")) return null;
    if (activeTaskRun2983) await attachTaskIo2983(activeTaskRun2983,sourceRoot);
    const source = await loadAnyIndex281(sourceRoot);
    const sourceFingerprint = await libraryFingerprint281(sourceRoot,source.index);
    const priorStaging=await readJson(sourceRoot,LIBRARY_UPGRADE_STAGING_PATH).catch(()=>null);
    await ensureNumberedStructure281(sourceRoot);
    const stagingBase=canResumeUpgradeTarget281(priorStaging,sourceFingerprint)
      ? {...priorStaging,updated_at:new Date().toISOString(),mode:"in-place"}
      : { schema_version:"1.1", complete:false, source_fingerprint:sourceFingerprint, source_name:String(sourceRoot.name || ""), started_at:new Date().toISOString(), updated_at:new Date().toISOString(), mode:"in-place", resolutions:{} };
    await writeJson(sourceRoot,LIBRARY_UPGRADE_STAGING_PATH,stagingBase);
    const collected = await collectProvenManagedAssets281(sourceRoot);
    const copyResult = await copyManagedAssetManifest281(collected.assets,managedAssetIo281(sourceRoot,sourceRoot),{ inPlace:true, resolutions:stagingBase.resolutions || {}, taskRun:activeTaskRun2983, progress:({position,total,target_path})=>updateUpgradeProgress281(`正在原地升级 ${position}/${total}\n${target_path}\n只处理能够证明由插件创建的资产。`) });
    if (!copyResult.complete) {
      try { await persistUserConfigConflicts2984(sourceRoot, copyResult); } catch (error) { console.warn?.("用户配置冲突清单登记失败", error); }
      const persisted=await persistUpgradeConflictState2983(sourceRoot,stagingBase,copyResult,{mode:"in-place",sourceFingerprint,sourceName:sourceRoot.name});
      renderUpgradeConflicts2983(persisted.conflicts || [],{mode:"in-place",sourceRoot,targetHandle:sourceRoot,sourceFingerprint});
      updateUpgradeProgress281(`原地升级尚未完成\n成功 ${copyResult.verified}/${copyResult.total}｜失败 ${copyResult.failed}｜冲突 ${copyResult.conflicts}\n未验证成功的旧资产没有删除。`,"warning");
      const error=new Error(`原地升级未完成：成功 ${copyResult.verified}/${copyResult.total}，失败 ${copyResult.failed}，冲突 ${copyResult.conflicts}。未验证成功的旧资产没有删除。`);
      error.code=copyResult.conflicts ? "LIBRARY_UPGRADE_CONFLICT" : "LIBRARY_UPGRADE_FAILED";
      throw error;
    }
    clearUpgradeConflicts2983();
    await remapLayoutMetadata299(sourceRoot);
    const validation = await validateMigratedLibrary281(collected.index,sourceRoot);
    const commitCandidate={...copyResult,complete:copyResult.complete&&validation.ok};
    if(!canCommitLibraryUpgrade281(commitCandidate)) throw new Error(`原地升级校验没有通过；缺少 ${validation.missing.length} 个 Conversation。旧副本不会继续清理。`);
    await writeUpgradeReceipt281(sourceRoot,"in-place",sourceFingerprint,copyResult,validation,sourceRoot.name);
    await cleanupEmptyLegacyRoots281(sourceRoot);
    if (activeTaskRun2983) taskEvent2983(activeTaskRun2983,{type:"migration_commit",stage:"commit",status:"complete",critical:true,verified:copyResult.verified,total:copyResult.total,deduplicated:copyResult.deduplicated || 0});
    hideLibraryUpgradeWizard281();
    setStatus(`原地升级完成\n已校验 ${copyResult.verified} 个目标资产。\n用户自行放入或来源无法确认的文件保持原位。`,"ok");
    return { targetHandle:sourceRoot,copyResult,validation };
  }

  async function maybePromptLibraryUpgrade281(root) {
    await recoverInterruptedTaskLogs2983(root);
    const probe = await probeLibraryUpgrade281(root);
    if (needsLibraryUpgrade281(probe)) showLibraryUpgradeWizard281(probe);
    else hideLibraryUpgradeWizard281();
    return probe;
  }

  function showLibraryUpgradeWizard281(probe = {}) {
    if (!ui?.upgradeModal) return;
    ui._upgradeProbe = probe;
    ui.upgradeModal.dataset.defaultMode = defaultUpgradeMode281();
    if (ui.upgradeSource) ui.upgradeSource.textContent = `${probe?.root?.name || "当前资料库"}${probe?.sourceVersion ? ` · v${probe.sourceVersion}` : ""}${probe?.conversationCount ? ` · ${probe.conversationCount} 个已索引对话` : ""}`;
    if (ui.upgradeProgress) { ui.upgradeProgress.textContent = "推荐新建一个空目录：插件只把自己能确认的资产迁过去，旧目录完全保留。"; ui.upgradeProgress.dataset.kind = "normal"; }
    ui.upgradeModal.hidden = false;
  }

  function hideLibraryUpgradeWizard281() {
    if (ui?.upgradeModal) ui.upgradeModal.hidden = true;
    clearUpgradeConflicts2983();
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

  async function moveLegacyPath299(root, sourcePath, destinationPath) {
    if (!sourcePath || !destinationPath || sourcePath === destinationPath) return { moved:0, conflicts:[] };
    try {
      const sourceHandle = await getFileHandle(root, sourcePath, false);
      const sourceFile = await sourceHandle.getFile();
      const sourceBytes = new Uint8Array(await sourceFile.arrayBuffer());
      try {
        const targetHandle = await getFileHandle(root, destinationPath, false);
        const targetFile = await targetHandle.getFile();
        const targetBytes = new Uint8Array(await targetFile.arrayBuffer());
        const same = sourceBytes.length === targetBytes.length && sourceBytes.every((value, index) => value === targetBytes[index]);
        if (!same) return { moved:0, conflicts:[`${sourcePath}：目标位置已有不同内容，已保留旧文件`] };
      } catch (error) { if (error?.name !== "NotFoundError") throw error; else await writeBinary(root, destinationPath, sourceBytes); }
      await removeFile(root, sourcePath);
      try { await removeEmptyAncestorDirectories(root, sourcePath); } catch { /* best effort */ }
      return { moved:1, conflicts:[] };
    } catch (error) {
      if (error?.name === "NotFoundError") return { moved:0, conflicts:[] };
      throw error;
    }
  }

  async function migrateLegacyTree299(root, legacyRoot) {
    let directory;
    try { directory = await getDirectory(root, legacyRoot, false); }
    catch (error) { if (error?.name === "NotFoundError") return { moved:0, conflicts:[] }; throw error; }
    const files = [];
    for await (const entry of walkDirectory(directory)) files.push(entry.path);
    let moved = 0; const conflicts = [];
    for (const relative of files) {
      const source = joinPath(legacyRoot, relative);
      const destination = mapLegacyLibraryPath299(source);
      const result = await moveLegacyPath299(root, source, destination);
      moved += result.moved; conflicts.push(...result.conflicts);
    }
    try { await root.removeEntry(legacyRoot, { recursive:false }); } catch { /* non-empty/conflict => keep */ }
    return { moved, conflicts };
  }

  async function remapExistingPath299(root, value) {
    const source = normalizeStatePath(value || "");
    if (!source) return "";
    const target = mapLegacyLibraryPath299(source);
    if (!target || target === source) return source;
    try { await getFileHandle(root, source, false); return source; }
    catch (error) { if (error?.name !== "NotFoundError") throw error; }
    try { await getFileHandle(root, target, false); return target; }
    catch (error) { if (error?.name !== "NotFoundError") throw error; }
    return source;
  }

  async function remapLayoutMetadata299(root) {
    const index = await readJson(root, `${META_DIR}/index.json`);
    if (index?.conversations && typeof index.conversations === "object") {
      for (const entry of Object.values(index.conversations)) {
        entry.raw_path = await remapExistingPath299(root, entry.raw_path);
        entry.json_path = await remapExistingPath299(root, entry.json_path);
        entry.markdown_path = await remapExistingPath299(root, entry.markdown_path);
        entry.pdf_path = await remapExistingPath299(root, entry.pdf_path);
        if (Array.isArray(entry.view_paths)) entry.view_paths = await Promise.all(entry.view_paths.map((path) => remapExistingPath299(root, path)));
        if (Array.isArray(entry.project_views)) {
          for (const view of entry.project_views) view.path = await remapExistingPath299(root, view.path);
        }
      }
      await persistIndexes(root, index);
    }
    const state = await readJson(root, CONVERSATION_STATE_PATH);
    if (state?.conversations && typeof state.conversations === "object") {
      let changed = false;
      for (const item of Object.values(state.conversations)) {
        if (!item?.last_known) continue;
        const jsonPath = await remapExistingPath299(root, item.last_known.json_path);
        const markdownPath = await remapExistingPath299(root, item.last_known.markdown_path);
        if (jsonPath !== item.last_known.json_path || markdownPath !== item.last_known.markdown_path) changed = true;
        item.last_known.json_path = jsonPath;
        item.last_known.markdown_path = markdownPath;
      }
      if (changed) await writeJson(root, CONVERSATION_STATE_PATH, state);
    }
  }

  async function migrateLegacyEngineeringLayout299(root) {
    let moved = 0; const conflicts = [];
    for (const file of ["conversation-index.json", "timeline.json"]) {
      const result = await moveLegacyPath299(root, file, mapLegacyLibraryPath299(file));
      moved += result.moved; conflicts.push(...result.conflicts);
    }
    for (const dir of ["提取历史", LEGACY_META_DIR, "归档", LEGACY_ARCHIVE_FOLDER, "已删除", LEGACY_DELETED_FOLDER, "原始", "JSON", "Markdown", "PDF", "项目"]) {
      const result = await migrateLegacyTree299(root, dir);
      moved += result.moved; conflicts.push(...result.conflicts);
    }
    await remapLayoutMetadata299(root);
    return { moved, conflicts };
  }

  async function cleanupLegacyViewRoots299(root) {
    for (const name of ["原始","JSON","Markdown","PDF","项目"]) {
      try { await root.removeEntry(name, { recursive:false }); } catch { /* only remove when empty */ }
    }
  }

  async function ensureArchiveStructure(root) {
    if (!root) return { moved:0, conflicts:[] };
    const probe = await probeLibraryUpgrade281(root);
    if (needsLibraryUpgrade281(probe)) {
      showLibraryUpgradeWizard281(probe);
      const error = new Error("检测到旧版资料库，请先完成升级向导；在你选择之前不会自动移动或删除旧目录里的文件");
      error.code = "LIBRARY_UPGRADE_REQUIRED";
      throw error;
    }
    await ensureNumberedStructure281(root);
    return { moved:0, conflicts:[] };
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


  function rawPathForIndexEntry295(entry = {}) {
    if (entry?.raw_path) return normalizeStatePath(entry.raw_path);
    const jsonPath = normalizeStatePath(entry?.json_path || "");
    if (jsonPath.toLowerCase().startsWith(`${JSON_ROOT}/`.toLowerCase())) return jsonPath.replace(new RegExp(`^${JSON_ROOT}/`, "i"), `${RAW_ROOT}/`);
    if (jsonPath.toLowerCase().startsWith("json/")) return jsonPath.replace(/^JSON\//i, `${RAW_ROOT}/`);
    return jsonPath;
  }

  function pdfPathForMarkdown295(markdownPath = "") {
    const path = normalizeStatePath(markdownPath);
    if (path.toLowerCase().startsWith(`${MARKDOWN_ROOT}/`.toLowerCase())) return path.replace(new RegExp(`^${MARKDOWN_ROOT}/`, "i"), `${PDF_ROOT}/`).replace(/\.md$/i, ".pdf");
    return path.replace(/^Markdown\//i, `${PDF_ROOT}/`).replace(/\.md$/i, ".pdf");
  }

  async function readRawArchive295(root, entry = {}) {
    const candidates = [...new Set([
      normalizeStatePath(entry?.raw_path || ""),
      rawPathForIndexEntry295(entry),
      normalizeStatePath(entry?.json_path || ""),
    ].filter(Boolean))];
    const errors = [];
    for (const path of candidates) {
      try {
        const data = await readJson(root, path);
        if (data?.conversation_id && (data?.raw?.mapping || data?.mapping || Array.isArray(data?.messages))) return { archive:data, path };
        errors.push(`${path}: 不是可恢复的原始档案`);
      } catch (error) { errors.push(`${path}: ${error.message || error}`); }
    }
    throw new Error(errors.length ? errors.join("；") : "找不到原始档案");
  }

  function cleanConversationFromArchive295(archive) {
    const mapping = archive?.raw?.mapping || archive?.mapping || {};
    const clean = V295.cleanConversation({
      id: archive?.conversation_id,
      conversation_id: archive?.conversation_id,
      title: archive?.title,
      create_time: archive?.create_time,
      update_time: archive?.update_time,
      mapping,
    });
    if (!clean.messages.length && Array.isArray(archive?.messages)) {
      clean.messages = archive.messages
        .filter((message) => ["user", "assistant"].includes(message?.role))
        .map((message) => ({ role: message.role, text: String(message?.content || ""), created_at: message?.occurred_at || null, files: message?.files || [] }))
        .filter((message) => message.text || message.files.length);
    }
    clean.exporter_version = VERSION;
    clean.classification = archive?.classification || null;
    clean.project_memberships = archive?.project_memberships || [];
    return clean;
  }

  function plannedViewState295(archive) {
    const views = V295.planPersistentViews({
      conversation_id: archive?.conversation_id,
      title: archive?.title,
      classification: archive?.classification,
      project_memberships: archive?.project_memberships || [],
    });
    const primary = Object.fromEntries(views.filter((item) => item.view === "classification").map((item) => [item.kind, item.path]));
    const projectViews = views.filter((item) => item.view === "project");
    return { views, primary, projectViews };
  }

  async function writeAllConversationViews295(root, archive) {
    const plan = plannedViewState295(archive);
    const clean = cleanConversationFromArchive295(archive);
    clean.raw_path = plan.primary.raw;
    clean.json_path = plan.primary.json;
    clean.markdown_path = plan.primary.markdown;
    clean.pdf_path = plan.primary.pdf;
    clean.export_revision = archive.export_revision || null;
    const markdown = V295.renderCleanMarkdown(clean);
    const pdf = await V295.renderMarkdownToPdfBytes(markdown, { title: archive?.title || "未命名对话" });
    const rawPayload = {
      ...archive,
      raw_path: plan.primary.raw,
      json_path: plan.primary.json,
      markdown_path: plan.primary.markdown,
      pdf_path: plan.primary.pdf,
      view_paths: plan.views.map((item) => item.path),
      project_views: plan.projectViews.map((item) => ({ kind:item.kind, project_id:item.project_id || null, project_name:item.project_name || "", path:item.path })),
    };
    for (const view of plan.views.filter((item) => item.kind === "raw")) await writeJson(root, view.path, rawPayload);
    for (const view of plan.views.filter((item) => item.kind === "json")) await writeJson(root, view.path, clean);
    for (const view of plan.views.filter((item) => item.kind === "markdown")) await writeText(root, view.path, markdown);
    for (const view of plan.views.filter((item) => item.kind === "pdf")) await writeBinary(root, view.path, pdf);
    return { plan, clean, markdown, pdf, rawPayload };
  }

  function indexEntryFromArchive295(archive, plan = plannedViewState295(archive)) {
    return {
      conversation_id: archive.conversation_id,
      title: archive.title,
      create_time: archive.create_time,
      update_time: archive.update_time,
      message_count: archive.messages?.length || 0,
      export_revision: archive.export_revision,
      raw_path: plan.primary.raw,
      json_path: plan.primary.json,
      markdown_path: plan.primary.markdown,
      pdf_path: plan.primary.pdf,
      view_paths: plan.views.map((item) => item.path),
      project_views: plan.projectViews.map((item) => ({ kind:item.kind, project_id:item.project_id || null, project_name:item.project_name || "", path:item.path })),
      project_memberships: archive?.project_memberships || [],
      classification: archive.classification || { kind: "未归类", name: "" },
    };
  }

  async function stageConversationWrite295({ root, freshArchive, oldEntry, now = Date.now(), exportRevision = createExportRevision() }) {
    const writeRecovery = async (originalPath, error) => {
      const recovery = recoveryPath(freshArchive.conversation_id, now);
      await writeJson(root, recovery, freshArchive);
      return { kind:"recovery", partial:true, recovery_path:recovery, original_path:originalPath || "", parse_error:error.message || String(error), conversation_id:freshArchive.conversation_id };
    };
    let oldArchive = null;
    if (oldEntry) {
      try { oldArchive = (await readRawArchive295(root, oldEntry)).archive; }
      catch (error) { return writeRecovery(oldEntry.raw_path || oldEntry.json_path || "", error); }
    }
    const merged = mergeArchives(oldArchive, freshArchive);
    const archive = { ...merged.archive, project_memberships: freshArchive?.project_memberships || merged.archive?.project_memberships || [] };
    archive.export_revision = exportRevision;
    const plan = plannedViewState295(archive);
    const pending = {
      schema_version:"2.9.5-views-1",
      conversation_id:archive.conversation_id,
      export_revision:exportRevision,
      expected_update_time:archive.update_time || null,
      expected_message_count:Number(archive.messages?.length || 0),
      raw_path:plan.primary.raw,
      json_path:plan.primary.json,
      markdown_path:plan.primary.markdown,
      pdf_path:plan.primary.pdf,
      view_paths:plan.views.map((item) => item.path),
      project_views:plan.projectViews,
      stage:"prepared",
      started_at:new Date().toISOString(),
    };
    const pendingFile = pendingPath(archive.conversation_id);
    await writeJson(root, pendingFile, pending);
    const written = await writeAllConversationViews295(root, archive);
    pending.stage = "views_written";
    await writeJson(root, pendingFile, pending);
    return {
      kind:"staged", archive:written.rawPayload, plan:written.plan,
      paths:{ raw:written.plan.primary.raw, json:written.plan.primary.json, markdown:written.plan.primary.markdown, pdf:written.plan.primary.pdf },
      pending, pending_path:pendingFile, preserved:merged.preserved,
      old_view_paths:Array.isArray(oldEntry?.view_paths) ? oldEntry.view_paths : [oldEntry?.raw_path,oldEntry?.json_path,oldEntry?.markdown_path,oldEntry?.pdf_path].filter(Boolean),
    };
  }

  async function finalizeConversationWrite295(root, staged, index) {
    const record = staged.pending;
    const errors = [];
    try {
      const raw = await readJson(root, record.raw_path);
      if (String(raw?.conversation_id || "") !== String(record.conversation_id)) errors.push("原始 conversation_id 不一致");
      if (String(raw?.export_revision || "") !== String(record.export_revision)) errors.push("原始 export_revision 不一致");
    } catch (error) { errors.push(`原始读取失败：${error.message || error}`); }
    try {
      const clean = await readJson(root, record.json_path);
      if (String(clean?.conversation_id || "") !== String(record.conversation_id)) errors.push("JSON conversation_id 不一致");
    } catch (error) { errors.push(`JSON 读取失败：${error.message || error}`); }
    try {
      const md = await readText(root, record.markdown_path);
      if (!md || !md.startsWith("# ")) errors.push("Markdown 内容无效");
    } catch (error) { errors.push(`Markdown 读取失败：${error.message || error}`); }
    try {
      if (!(await validPdfView295(root, record.pdf_path))) errors.push(`PDF 文件头或阅读视图版本无效（需要 ${VIEW_RENDER_VERSION_2983}）`);
    } catch (error) { errors.push(`PDF 读取失败：${error.message || error}`); }
    const idx = index?.conversations?.[record.conversation_id];
    if (!idx || idx.raw_path !== record.raw_path || idx.json_path !== record.json_path || idx.markdown_path !== record.markdown_path || idx.pdf_path !== record.pdf_path) errors.push("索引路径不一致");
    if (errors.length) return { complete:false, repaired:false, errors };
    record.stage = "committed";
    await writeJson(root, staged.pending_path, record);
    await removeFile(root, staged.pending_path);
    const keep = new Set(record.view_paths || []);
    for (const oldPath of staged.old_view_paths || []) {
      if (!oldPath || keep.has(oldPath)) continue;
      try { await removeFile(root, oldPath); await removeEmptyAncestorDirectories(root, oldPath); }
      catch (error) { if (error?.name !== "NotFoundError") console.warn("旧视图清理失败", oldPath, error); }
    }
    return { complete:true, repaired:true, errors:[] };
  }

  async function recoverPendingCommit295(root, pendingFile, record, index) {
    const errors = [];
    let raw = null;
    try { raw = await readJson(root, record.raw_path); }
    catch (error) { errors.push(`原始读取失败：${error.message || error}`); }
    if (!raw?.conversation_id || String(raw.conversation_id) !== String(record.conversation_id)) return { complete:false, repaired:false, errors:[...errors,"缺少可恢复的原始档案"] };
    try {
      raw.export_revision = record.export_revision || raw.export_revision;
      const written = await writeAllConversationViews295(root, raw);
      index.conversations[record.conversation_id] = indexEntryFromArchive295(written.rawPayload, written.plan);
      await persistIndexes(root, index);
      const staged = { pending:record, pending_path:pendingFile, old_view_paths:[], archive:written.rawPayload, plan:written.plan };
      return finalizeConversationWrite295(root, staged, index);
    } catch (error) { return { complete:false, repaired:false, errors:[...errors,`恢复失败：${error.message || error}`] }; }
  }
  async function validPdfView295(root, path) {
    try {
      const handle = await getFileHandle(root, path, false);
      const file = await handle.getFile();
      if (file.size < 8) return false;
      const head = new TextDecoder().decode(new Uint8Array(await file.slice(0, Math.min(file.size, 512)).arrayBuffer()));
      if (!head.startsWith("%PDF")) return false;
      return head.includes(`%AIChatFlow-Renderer:${VIEW_RENDER_VERSION_2983}`);
    } catch (error) {
      if (error?.name === "NotFoundError") return false;
      throw error;
    }
  }

  async function conversationViewsComplete295(root, archive, { includePdf = true } = {}) {
    const plan = plannedViewState295(archive);
    for (const view of plan.views) {
      if (!includePdf && view.kind === "pdf") continue;
      if (view.kind === "pdf") {
        if (!(await validPdfView295(root, view.path))) return false;
        continue;
      }
      const text = await readText(root, view.path);
      if (text === null) return false;
      if (view.kind === "raw") {
        try {
          const data = JSON.parse(text);
          if (String(data?.conversation_id || "") !== String(archive?.conversation_id || "")) return false;
          if (String(data?.exporter_version || "") !== VERSION) return false;
          if (!(data?.raw?.mapping || data?.mapping || Array.isArray(data?.messages))) return false;
        } catch { return false; }
      } else if (view.kind === "json") {
        try {
          const data = JSON.parse(text);
          if (String(data?.conversation_id || "") !== String(archive?.conversation_id || "")) return false;
          if (!String(data?.schema_version || "").startsWith("2.9.5-clean-")) return false;
        } catch { return false; }
      } else if (view.kind === "markdown") {
        if (!text.startsWith("# ")) return false;
      }
    }
    return true;
  }

  async function backfillLibraryViews295(root, {
    includePdf = true,
    remoteItems = [],
    conversationIds = null,
    projectMembershipsAuthoritative = false,
    progress = () => {},
    isCancelled = () => false,
  } = {}) {
    if (!root) throw new Error("缺少本地资料库目录");
    await ensureArchiveStructure(root);
    const loaded = await ensureIndex(root, false);
    const index = loaded.index;
    const idFilter = conversationIds ? new Set([...conversationIds].map(String)) : null;
    const entries = Object.values(index?.conversations || {}).filter((entry) => !idFilter || idFilter.has(String(entry?.conversation_id || "")));
    const remoteById = new Map((remoteItems || []).map((item) => [String(item?.id || item?.conversation_id || ""), item]).filter(([id]) => id));
    const upgraded = [];
    const skipped = [];
    const failed = [];

    for (const [position, entry] of entries.entries()) {
      if (isCancelled()) break;
      const title = entry?.title || entry?.conversation_id || "未命名对话";
      progress({ phase:"scan", position:position + 1, total:entries.length, conversation_id:entry?.conversation_id || "", title });
      await sleep(0);
      try {
        const { archive } = await readRawArchive295(root, entry);
        const remoteItem = remoteById.get(String(archive?.conversation_id || entry?.conversation_id || ""));
        const remoteHasMembershipEvidence = Boolean(remoteItem && Object.prototype.hasOwnProperty.call(remoteItem, "project_memberships"));
        const remoteProjectMemberships = remoteHasMembershipEvidence && Array.isArray(remoteItem?.project_memberships)
          ? remoteItem.project_memberships.map((item) => ({ id:String(item?.id || ""), name:String(item?.name || "未命名项目") })).filter((item) => item.id || item.name)
          : null;
        const localProjectMemberships = Array.isArray(archive?.project_memberships)
          ? archive.project_memberships
          : Array.isArray(entry?.project_memberships) ? entry.project_memberships : [];
        let nextProjectMemberships = localProjectMemberships;
        if (remoteProjectMemberships !== null) {
          if (projectMembershipsAuthoritative) {
            nextProjectMemberships = remoteProjectMemberships;
          } else if (remoteProjectMemberships.length) {
            const mergedMemberships = new Map(normalizeProjectMemberships295(localProjectMemberships).map((item) => [String(item.id || item.name), item]));
            for (const item of normalizeProjectMemberships295(remoteProjectMemberships)) mergedMemberships.set(String(item.id || item.name), item);
            nextProjectMemberships = [...mergedMemberships.values()];
          }
        }
        const freshArchive = {
          ...archive,
          exporter_version: VERSION,
          project_memberships: nextProjectMemberships,
        };
        if (await conversationViewsComplete295(root, freshArchive, { includePdf })) {
          skipped.push({ conversation_id:freshArchive.conversation_id, title:freshArchive.title || title });
          continue;
        }
        if (String(archive?.exporter_version || "") !== VERSION) {
          const oldMarkdownPath = normalizeStatePath(entry?.markdown_path || "");
          if (oldMarkdownPath) {
            const oldMarkdown = await readText(root, oldMarkdownPath);
            if (oldMarkdown !== null) {
              const relative = oldMarkdownPath.replace(/^Markdown\//i, "").replace(new RegExp(`^${MARKDOWN_ROOT}/`, "i"), "");
              const backupPath = joinPath(META_DIR, "backups", "2.9.4-markdown", relative);
              if ((await readText(root, backupPath)) === null) await writeText(root, backupPath, oldMarkdown);
            }
          }
        }
        const staged = await stageConversationWrite295({ root, freshArchive, oldEntry:entry });
        if (staged.kind !== "staged") throw new Error(`旧档案无法安全读取，已写入恢复区：${staged.recovery_path}`);
        index.conversations[staged.archive.conversation_id] = indexEntryFromArchive295(staged.archive, staged.plan);
        await persistIndexes(root, index);
        staged.pending.stage = "index_written";
        await writeJson(root, staged.pending_path, staged.pending);
        const finalized = await finalizeConversationWrite295(root, staged, index);
        if (!finalized.complete) throw new Error(`补齐校验失败：${finalized.errors.join("；")}`);
        upgraded.push({
          conversation_id:staged.archive.conversation_id,
          title:staged.archive.title,
          raw_path:staged.paths.raw,
          json_path:staged.paths.json,
          markdown_path:staged.paths.markdown,
          pdf_path:staged.paths.pdf,
        });
        progress({ phase:"upgraded", position:position + 1, total:entries.length, conversation_id:staged.archive.conversation_id, title:staged.archive.title });
      } catch (error) {
        failed.push({ conversation_id:entry?.conversation_id || "", title, reason:error.message || String(error) });
        progress({ phase:"failed", position:position + 1, total:entries.length, conversation_id:entry?.conversation_id || "", title, reason:error.message || String(error) });
      }
    }
    return { upgraded, skipped, failed, cancelled:isCancelled(), total:entries.length };
  }

  function normalizeProjectMemberships295(value) {
    return (Array.isArray(value) ? value : [])
      .map((item) => ({ id:String(item?.id || ""), name:String(item?.name || "未命名项目") }))
      .filter((item) => item.id || item.name)
      .sort((a, b) => `${a.id}|${a.name}`.localeCompare(`${b.id}|${b.name}`, "zh-CN"));
  }

  function projectMembershipsEqual295(a, b) {
    return JSON.stringify(normalizeProjectMemberships295(a)) === JSON.stringify(normalizeProjectMemberships295(b));
  }

  async function readViewMigrationState295(root) {
    try { return await readJson(root, VIEW_MIGRATION_STATE_PATH); }
    catch (error) { if (error?.name === "NotFoundError") return null; throw error; }
  }

  async function runAutomaticViewMigration295(root, environment, progress = () => {}) {
    const remoteItems = environment?.inventory?.items || [];
    const index = environment?.index || emptyIndex();
    const remoteById = new Map(remoteItems.map((item) => [String(item?.id || item?.conversation_id || ""), item]).filter(([id]) => id));
    const state = await readViewMigrationState295(root);
    const firstUpgrade = !state || state?.render_version !== VIEW_RENDER_VERSION_2983 || state?.complete !== true;
    const projectInventoryComplete = environment?.inventory?.projects?.supported === true && !environment?.inventory?.projects?.warning;
    const membershipDrift = [];
    for (const [id, entry] of Object.entries(index?.conversations || {})) {
      const remote = remoteById.get(String(id));
      if (!remote || !Object.prototype.hasOwnProperty.call(remote, "project_memberships")) continue;
      const remoteMemberships = normalizeProjectMemberships295(remote?.project_memberships);
      if (projectInventoryComplete) {
        if (!projectMembershipsEqual295(entry?.project_memberships, remoteMemberships)) membershipDrift.push(String(id));
      } else if (remoteMemberships.length) {
        const localKeys = new Set(normalizeProjectMemberships295(entry?.project_memberships).map((item) => String(item.id || item.name)));
        if (remoteMemberships.some((item) => !localKeys.has(String(item.id || item.name)))) membershipDrift.push(String(id));
      }
    }
    if (!firstUpgrade && membershipDrift.length === 0) return { ran:false, firstUpgrade:false, membershipDrift:[], result:null, complete:projectInventoryComplete, projectInventoryComplete };
    const conversationIds = firstUpgrade ? null : membershipDrift;
    const result = await backfillLibraryViews295(root, {
      includePdf:true,
      remoteItems,
      conversationIds,
      projectMembershipsAuthoritative:projectInventoryComplete,
      isCancelled:() => cancelRequested,
      progress,
    });
    const complete = !result.cancelled && result.failed.length === 0 && projectInventoryComplete;
    await cleanupLegacyViewRoots299(root);
    await writeJson(root, VIEW_MIGRATION_STATE_PATH, {
      schema_version:"1.0", version:VERSION, render_version:VIEW_RENDER_VERSION_2983, complete,
      completed_at: complete ? new Date().toISOString() : null,
      last_attempt_at:new Date().toISOString(),
      project_inventory_complete:projectInventoryComplete,
      total:result.total, upgraded:result.upgraded.length, skipped:result.skipped.length, failed:result.failed.length,
    });
    return { ran:true, firstUpgrade, membershipDrift, result, complete, projectInventoryComplete };
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
      if (!entry.path.toLowerCase().startsWith(`${JSON_ROOT}/`.toLowerCase()) || !entry.path.toLowerCase().endsWith(".json")) continue;
      scanned++;
      progress(`正在重建索引：已扫描 ${scanned} 个 JSON`);
      try {
        const data = JSON.parse(await (await entry.handle.getFile()).text());
        const id = String(data?.conversation_id || "");
        if (!id) { issues.push(`${entry.path}: 非本插件 JSON 或缺少 conversation_id`); continue; }
        const markdownPath = data.markdown_path || entry.path.replace(new RegExp(`^${JSON_ROOT}/`), `${MARKDOWN_ROOT}/`).replace(/\.json$/i, ".md");
        let rawPath = data.raw_path || entry.path.replace(new RegExp(`^${JSON_ROOT}/`), `${RAW_ROOT}/`);
        if (data?.raw?.mapping) rawPath = entry.path;
        const pdfPath = data.pdf_path || pdfPathForMarkdown295(markdownPath);
        index.conversations[id] = {
          conversation_id:id, title:data.title || "未命名对话",
          create_time:data.create_time || null, update_time:data.update_time || null,
          message_count:Array.isArray(data.messages) ? data.messages.length : 0,
          export_revision:data.export_revision || null,
          raw_path:rawPath, json_path:entry.path, markdown_path:markdownPath, pdf_path:pdfPath,
          view_paths:Array.isArray(data.view_paths) ? data.view_paths : [rawPath,entry.path,markdownPath,pdfPath].filter(Boolean),
          project_views:Array.isArray(data.project_views) ? data.project_views : [],
          project_memberships:Array.isArray(data.project_memberships) ? data.project_memberships : [],
          classification:data.classification || { kind:"未归类", name:"" },
        };
      } catch (error) { issues.push(`${entry.path}: ${error.message}`); }
    }
    index.updated_at = new Date().toISOString();
    await persistIndexes(root, index);
    return { index, issues, scanned, persisted:true };
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
    await writeJson(root, PUBLIC_INDEX_PATH, publicIndex(index));
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
        const loaded = await readRawArchive295(root, entry);
        const archive = loaded.archive;
        if (archive?.conversation_id) archives.push({ ...archive, _json_path: loaded.path });
        else issues.push(`${entry.raw_path || entry.json_path}: 缺少 conversation_id`);
      } catch (error) {
        issues.push(`${entry.raw_path || entry.json_path}: ${error.message}`);
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
      `跳过：${result.skipped}`, `待确认：${Number(result.deferred || 0)}`, `失败：${result.failed.length}`, `保留较完整历史版本：${result.preserved}`,
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
        if (lower.startsWith(`${JSON_ROOT}/`.toLowerCase()) && lower.endsWith(".json")) {
          const data = JSON.parse(await (await entry.handle.getFile()).text());
          if (String(data?.conversation_id || "") === String(conversationId)) result.json.push(entry.path);
        } else if (lower.startsWith(`${MARKDOWN_ROOT}/`.toLowerCase()) && lower.endsWith(".md")) {
          const jsonPath = entry.path.replace(new RegExp(`^${MARKDOWN_ROOT}/`, "i"), `${JSON_ROOT}/`).replace(/\.md$/i, ".json");
          const data = await readJson(root, jsonPath);
          if (String(data?.conversation_id || "") === String(conversationId)) result.markdown.push(entry.path);
        }
      } catch { /* 损坏或非本插件文件不参与自动迁移，也不会被删除。 */ }
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
        const archive = (await readRawArchive295(root, { ...(entry || {}), json_path: copies.json[0] })).archive;
        if (String(archive?.conversation_id || "") !== String(conversationId)) throw new Error("源原始档案 conversation_id 校验失败");
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
        const staged = await stageConversationWrite295({ root, freshArchive: { ...archive, title, exporter_version: VERSION, classification }, oldEntry });
        if (staged.kind !== "staged") throw new Error(`源 JSON 无法安全读取，已写入恢复区：${staged.recovery_path}`);
        index.conversations[conversationId] = indexEntryFromArchive295(staged.archive, staged.plan);
        await persistIndexes(root, index);
        staged.pending.stage = "index_written";
        await writeJson(root, staged.pending_path, staged.pending);
        const finalized = await finalizeConversationWrite295(root, staged, index);
        if (!finalized.complete) throw new Error(`提交校验失败：${finalized.errors.join("；")}`);
        await removeVerifiedConversationDuplicates(root, conversationId, staged.paths);
        migrated.push({ conversation_id: conversationId, title, ...staged.paths });
      } catch (error) {
        failed.push({ conversation_id: conversationId, title: entry?.title || issue?.title || "", reason: error.message || String(error) });
      }
    }
    if (migrated.length) {
      const archives = await readIndexedArchives(root, index);
      if (!archives.issues.length) await writeJson(root, TIMELINE_PATH, timelineFromArchives(archives.archives));
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
        const archive = (await readRawArchive295(root, { ...originalEntry, json_path: actualJson })).archive;
        if (!archive?.conversation_id) throw new Error(`找不到可读取的原始档案：${actualJson}`);
        const oldEntry = { ...originalEntry, json_path: actualJson, markdown_path: actualMarkdown };
        const staged = await stageConversationWrite295({ root, freshArchive: { ...archive, exporter_version: VERSION, classification }, oldEntry });
        if (staged.kind !== "staged") throw new Error(`原 JSON 无法安全读取，已写入恢复区：${staged.recovery_path}`);
        index.conversations[staged.archive.conversation_id] = indexEntryFromArchive295(staged.archive, staged.plan);
        await persistIndexes(root, index);
        staged.pending.stage = "index_written";
        await writeJson(root, staged.pending_path, staged.pending);
        const finalized = await finalizeConversationWrite295(root, staged, index);
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
      if (!archives.issues.length) await writeJson(root, TIMELINE_PATH, timelineFromArchives(archives.archives));
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
      const result = record.schema_version === "2.9.5-views-1"
        ? await recoverPendingCommit295(root, item.path, record, index)
        : await recoverPendingCommit({
          io: directoryIo(root), pendingFile: item.path, record, index,
          renderMarkdown: buildMarkdown, persistIndex: (next) => persistIndexes(root, next),
        });
      if (result.complete) repaired.push(record.conversation_id);
      else unresolved.push(`${record.conversation_id}: ${result.errors.join("；")}`);
    }
    return { detected: pending.length, repaired, unresolved };
  }

  async function inspectEnvironment({ interactiveDirectory = false, directoryHandle = null } = {}) {
    const adapter = resolvePlatformAdapter();
    const session = await adapter.getSession();
    if (!session.ok) throw new Error(`当前登录或会话接口不可用${session.status ? `（HTTP ${session.status}）` : ""}`);
    const inventory = await adapter.fetchInventory(session);
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
      if (authorized.handle && activeTaskRun2983) await attachTaskIo2983(activeTaskRun2983,authorized.handle);
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
      `Project：${environment.inventory.projects?.rows?.length || 0} 个${environment.inventory.projects?.warning ? `（${environment.inventory.projects.warning}）` : ""}`,
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
    resetConversation4292985();
    const startedAt = new Date().toISOString();
    setStatus("正在准备导出；首次使用会请求选择导出目录……");
    // 目录选择必须紧邻用户点击，不能排在目录/网络扫描之后。
    const authorized = await getAuthorizedDirectory(true);
    const root = authorized.handle;
    if (!root) throw new Error(authorized.reason || "未获得导出目录");
    if (activeTaskRun2983) await attachTaskIo2983(activeTaskRun2983,root);
    await ensureArchiveStructure(root);
    await readSharedClassificationRules(root);
    // 2.9.7: migrate legacy views before old JSON/Markdown location-conflict gating.
    // A 2.9.4 conflict must not deadlock the migration that normalizes that legacy library.
    setStatus("正在读取网页目录，并检查本地视图状态……", "normal", true);
    const environment = await inspectEnvironment({ directoryHandle: root });
    const projectScopeComplete = environment?.inventory?.projects?.supported === true && !environment?.inventory?.projects?.warning;
    const migration = await runAutomaticViewMigration295(root, environment, ({ phase, position, total, title, conversation_id }) => {
      const verb = phase === "upgraded" ? "已更新本地视图" : phase === "failed" ? "本地视图处理失败" : "正在检查本地视图";
      setStatus(`${verb} ${position}/${total}\n${title || "未命名对话"}\n已完整的会跳过；只有缺失或需要升级的 原始 / JSON / Markdown / PDF 才会重新生成，并同步检查 Project 双视图。`, phase === "failed" ? "warning" : "normal", true);
      if (activeTaskRun2983) taskEvent2983(activeTaskRun2983,{type:"automatic_view_migration",stage:"view-migration",status:phase === "failed" ? "failed" : phase === "upgraded" ? "complete" : "processing",position,total,object_type:"conversation",object_id:String(conversation_id || title || position),name:title || null});
    });
    if (migration.ran) {
      const failed = migration.result?.failed?.length || 0;
      if (failed || migration.result?.cancelled) {
        setStatus(`本地视图检查/更新未完成\n已更新 ${migration.result?.upgraded?.length || 0}｜原本完整 ${migration.result?.skipped?.length || 0}｜失败 ${failed}\n旧文件没有被静默当成成功；处理完失败项后再继续完整保存。`, "warning");
        return;
      }
      if (!migration.projectInventoryComplete) {
        setStatus(`本地视图检查/更新完成，但 Project 清单不完整\n${environment.inventory.projects?.warning || "当前 Project 作用域无法完整确认"}\n本次不会把 Project 视图标记为完成；下次完整保存会继续重试。`, "warning");
      }
      const migratedIndex = await loadIndex(root);
      if (migratedIndex) {
        environment.index = migratedIndex;
        environment.plan = computeSyncPlan(environment.inventory.items || [], migratedIndex.conversations, Date.now(), classificationRules, classificationOverrides);
      }
    }

    setStatus("正在检查升级后的本地文件有没有移动或删除……", "normal", true);
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
    const refreshedIndexAfterLocalSettle = await loadIndex(root);
    if (refreshedIndexAfterLocalSettle) {
      environment.index = refreshedIndexAfterLocalSettle;
      environment.plan = computeSyncPlan(environment.inventory.items || [], refreshedIndexAfterLocalSettle.conversations, Date.now(), classificationRules, classificationOverrides);
    }
    const plan = environment.plan;
    const localPartition = partitionSyncQueueByLocalRisk2984(plan.queue, localAudit);
    const deferredLocal = localPartition.deferred;
    const syncQueue = localPartition.runnable;
    const remainingFolderChanges = localAudit.folderChanges?.length || 0;
    if (deferredLocal.length) {
      const names=deferredLocal.slice(0,8).map((item)=>item?.title || item?.id).filter(Boolean);
      if (activeTaskRun2983) taskEvent2983(activeTaskRun2983,{type:"conversation_deferred",stage:"local-audit",status:"warning",count:deferredLocal.length,conversation_ids:deferredLocal.map((item)=>String(item?.id || item?.conversation_id || "")),message:"仅暂停存在本地内容/表示风险的 Conversation；其他对话继续保存。"});
      setStatus(`本地检查完成\n${deferredLocal.length} 个 Conversation 暂不覆盖，其余 ${syncQueue.length} 个待处理 Conversation 继续保存。${remainingFolderChanges ? `\n另有 ${remainingFolderChanges} 个目录整理事项，不影响保存。` : ""}${settledLocal.failures.length ? `\n${settledLocal.failures.length} 项自动整理失败已记日志，不阻断其他 Conversation。` : ""}`, "warning", true);
    }
    if (!environment.canSync) {
      setStatus(`导出失败\n准备阶段没有通过：${environment.indexState}`, "error");
      return;
    }
    setStatus(`导出前统计\n${planSummary(plan)}\n需要读取正文 ${syncQueue.length} 个对话${deferredLocal.length ? `｜待确认 ${deferredLocal.length}` : ""}`, "normal", true);
    await sleep(50);

    const index = environment.index;
    const warnings = [...environment.indexIssues];
    let added = 0;
    let updated = 0;
    let preserved = 0;
    const changedConversations = [];
    const makeResult = (snapshot) => ({
      startedAt, finishedAt: new Date().toISOString(), summary: planSummary(plan), added, updated,
      skipped: plan.skip.length + Math.max(0, syncQueue.length - snapshot.written - snapshot.failures.length - snapshot.recoveries.length),
      deferred: deferredLocal.length,
      failed: snapshot.failures, warnings: Array.from(new Set(warnings)), preserved, written: snapshot.written,
      archivedBoundary: environment.inventory.archivedBoundary, cancelled: snapshot.cancelled,
      recoveries: snapshot.recoveries, stageFailures: snapshot.stageFailures,
    });
    const outcome = await executeSyncWorkflow({
      items: syncQueue,
      shouldCancel: () => cancelRequested,
      onProgress: (position, total, item) => {
        setStatus(`导出中 ${position}/${total}\n${item.title}\n${planSummary(plan)}`, "normal", true);
        if (activeTaskRun2983) {
          taskEvent2983(activeTaskRun2983,{type:"conversation_progress",stage:"conversation-sync",status:"processing",position,total,object_type:"conversation",object_id:String(item?.id || item?.conversation_id || ""),name:item?.title || null});
          void writeTaskCheckpoint2983(activeTaskRun2983,{phase:"conversation-sync",position,total,conversation_id:String(item?.id || item?.conversation_id || ""),resume_supported:false});
        }
      },
      processItem: async (item) => {
        const remote = await environment.adapter.fetchConversation(item.id, environment.session);
        const fresh = buildArchive(remote.data, item, classificationRules, classificationOverrides);
        const oldEntry = index.conversations[item.id];
        const staged = await stageConversationWrite295({ root, freshArchive: fresh, oldEntry });
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
        index.conversations[staged.archive.conversation_id] = indexEntryFromArchive295(staged.archive, staged.plan);
        changedConversations.push({
          conversation_id: staged.archive.conversation_id,
          title: staged.archive.title,
          update_time: staged.archive.update_time,
          export_revision: staged.archive.export_revision,
          message_count: staged.archive.messages?.length || 0,
          raw_path: staged.paths.raw,
          json_path: staged.paths.json,
          markdown_path: staged.paths.markdown,
          pdf_path: staged.paths.pdf,
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
        const finalized = await finalizeConversationWrite295(root, staged, index);
        if (!finalized.complete) throw new Error(`${staged.archive.conversation_id} 提交校验失败：${finalized.errors.join("；")}`);
      },      writeTimeline: async () => {
        const archiveResult = await readIndexedArchives(root, index);
        warnings.push(...archiveResult.issues);
        if (archiveResult.issues.length) {
          throw new Error(`有 ${archiveResult.issues.length} 个索引档案不可读，已保留旧 timeline`);
        }
        await writeJson(root, TIMELINE_PATH, timelineFromArchives(archiveResult.archives));
      },
      writeHistory: async (snapshot) => {
        const result = makeResult(snapshot);
        const report = buildReport(result);
        await appendHistory(root, {
          started_at: startedAt, finished_at: result.finishedAt, status: report.status,
          added, updated, skipped: result.skipped, deferred: result.deferred || 0, failed: result.failed.length, preserved,
        });
      },
      writeReport: async (snapshot) => writeText(root, `${META_DIR}/last-report.md`, buildReport(makeResult(snapshot)).markdown),
    });
    if (activeTaskRun2983) {
      for (const failure of outcome.failures || []) taskEvent2983(activeTaskRun2983,{type:"conversation_failure",stage:"conversation-sync",status:"failed",object_type:"conversation",object_id:String(failure?.id || failure?.conversation_id || "unknown"),error_code:failure?.code || "conversation_sync_failed",message:failure?.reason || failure?.message || "Conversation 同步失败"});
      for (const recovery of outcome.recoveries || []) taskEvent2983(activeTaskRun2983,{type:"conversation_recovery",stage:"conversation-sync",status:"warning",object_type:"conversation",object_id:String(recovery?.id || recovery?.conversation_id || "unknown"),message:recovery?.reason || "使用旁路恢复，未覆盖原文件"});
      for (const stageFailure of outcome.stageFailures || []) taskEvent2983(activeTaskRun2983,{type:"sync_stage_failure",stage:stageFailure?.stage || "sync",status:"failed",error_code:"sync_stage_failure",message:stageFailure?.reason || "同步阶段失败"});
      await writeTaskCheckpoint2983(activeTaskRun2983,{phase:"conversation-sync-finished",position:outcome.written || 0,total:syncQueue.length,resume_supported:false});
    }
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
    const fullyComplete = outcome.state === "完整同步" && projectScopeComplete;
    const outcomeLabel = fullyComplete
      ? "导出完成"
      : outcome.state === "完整同步" && !projectScopeComplete
        ? "导出完成，但 Project 清单不完整"
        : outcome.state === "部分同步" ? "导出完成，但有部分问题" : "导出失败";
    const projectDetails = projectScopeComplete ? "" : `\nProject：${environment.inventory.projects?.warning || "当前 Project 作用域无法完整确认"}`;
    const deferredDetails=deferredLocal.length ? `｜待确认 ${deferredLocal.length}` : "";
    setStatus(`${outcomeLabel}\n新增 ${added}｜更新 ${updated}｜未变化 ${result.skipped}｜失败 ${outcome.failures.length}${deferredDetails}${details}${stageDetails}${projectDetails}`, fullyComplete && !deferredLocal.length ? "ok" : outcome.state === "完整同步" || outcome.state === "部分同步" ? "warning" : "error");
  }


  function extractionOptionsFromUi() {
    const timeValue = ui?.extractTime?.value || "all";
    return normalizeExtractionOptions({
      source: ui?._extractSourceMode || "chatgpt",
      state: ui?.extractState?.value || "active",
      project: ui?._extractSourceMode === "project" ? (ui?.extractProject?.value || "") : "",
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

  function setExtractionSourceMode(mode, { clearSelection = true } = {}) {
    if (!ui) return;
    ui._extractSourceMode = normalizeExtractionSourceMode(mode);
    if (ui.extractSourceChatgpt) ui.extractSourceChatgpt.dataset.active = String(ui._extractSourceMode === "chatgpt");
    if (ui.extractSourceProject) ui.extractSourceProject.dataset.active = String(ui._extractSourceMode === "project");
    if (ui.extractProjectField) ui.extractProjectField.hidden = ui._extractSourceMode !== "project";
    if (clearSelection) ui._extractSelectedIds = new Set();
    invalidateExtractionPreview();
  }

  function populateExtractionFilters(entries = []) {
    if (!ui?.extractField || !ui?.extractFolder || !ui?.extractProject) return;
    const currentField = ui.extractField.value;
    const currentFolder = ui.extractFolder.value;
    const currentProject = ui.extractProject.value;
    const fields = [...new Set(entries.map(extractionFieldFromEntry).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const folders = [...new Set(entries.map(extractionFolderFromEntry).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const projects = new Map();
    for (const entry of entries) for (const project of extractionProjectViewMemberships(entry)) {
      const key = extractionProjectKey(project);
      if (key && !projects.has(key)) projects.set(key, project.name || project.id || "未命名项目");
    }
    ui.extractField.innerHTML = '<option value="">全部命名</option>' + fields.map((field) => `<option value="${escapeHtml(field)}">${escapeHtml(field)}</option>`).join("");
    ui.extractFolder.innerHTML = '<option value="">全部文件夹</option>' + folders.map((folder) => `<option value="${escapeHtml(folder)}">${escapeHtml(folder)}</option>`).join("");
    ui.extractProject.innerHTML = '<option value="">全部项目</option>' + [...projects.entries()].sort((a,b) => a[1].localeCompare(b[1], "zh-CN")).map(([key,name]) => `<option value="${escapeHtml(key)}">${escapeHtml(name)}</option>`).join("");
    if (fields.includes(currentField)) ui.extractField.value = currentField;
    if (folders.includes(currentFolder)) ui.extractFolder.value = currentFolder;
    if (projects.has(currentProject)) ui.extractProject.value = currentProject;
  }

  function renderExtractionCandidates(entries) {
    if (!ui?.extractResults || !ui?.extractList || !ui?.extractSummary) return;
    ui._extractCandidates = entries;
    ui.extractResults.hidden = false;
    const selectedIds = ui._extractSelectedIds instanceof Set ? ui._extractSelectedIds : (ui._extractSelectedIds = new Set());
    ui.extractSummary.textContent = `找到 ${entries.length} 个对话｜已选 ${selectedIds.size} 个`;
    if (!entries.length) {
      ui.extractList.innerHTML = '<div class="empty">没有找到符合条件的对话。</div>';
      return;
    }
    const visible = entries.slice(0, 500);
    ui.extractList.innerHTML = visible.map((entry) => {
      const time = entry.update_time ? String(entry.update_time).slice(0, 10) : "时间未知";
      const field = extractionFieldFromEntry(entry);
      const folder = extractionFolderFromEntry(entry) || "未归类";
      const projects = extractionProjectMemberships(entry).map((item) => item.name || item.id).filter(Boolean).join("、");
      const state = extractionStateFromEntry(entry) === "archived" ? "归档" : "当前";
      return `<label class="extract-row"><input type="checkbox" data-role="extract-select" value="${escapeHtml(entry.conversation_id)}" /><span><strong>${escapeHtml(entry.title || "未命名对话")}</strong><small>${escapeHtml([time, state, field, folder, projects ? `Project：${projects}` : ""].filter(Boolean).join(" · "))}</small></span></label>`;
    }).join("") + (entries.length > visible.length ? `<div class="hint">列表只展示前 ${visible.length} 个；请缩小筛选范围后再打包。</div>` : "");
    for (const input of ui.extractList.querySelectorAll('[data-role="extract-select"]')) input.checked = selectedIds.has(String(input.value));
  }

  async function prepareExtractionCatalog({ interactive = false } = {}) {
    const directory = await getAuthorizedDirectory(interactive);
    if (!directory.handle) return null;
    await ensureArchiveStructure(directory.handle);
    await readSharedClassificationRules(directory.handle);
    const index = await ensureIndex(directory.handle).then((result) => result.index);
    const conversationState = await loadConversationState(directory.handle);
    const catalogEntries = buildExtractionCatalogEntries(index, conversationState);
    ui._extractIndex = index;
    ui._extractCatalogEntries = catalogEntries;
    ui._extractSelectedIds = reconcileExtractionSelection(ui._extractSelectedIds || new Set(), catalogEntries);
    populateExtractionFilters(catalogEntries);
    return index;
  }

  async function previewExtraction() {
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    await readSharedClassificationRules(directory.handle);
    const index = await ensureIndex(directory.handle).then((result) => result.index);
    const conversationState = await loadConversationState(directory.handle);
    const catalogEntries = buildExtractionCatalogEntries(index, conversationState);
    ui._extractIndex = index;
    ui._extractCatalogEntries = catalogEntries;
    ui._extractSelectedIds = reconcileExtractionSelection(ui._extractSelectedIds || new Set(), catalogEntries);
    populateExtractionFilters(catalogEntries);
    const entries = filterExtractionEntries(catalogEntries, extractionOptionsFromUi());
    renderExtractionCandidates(entries);
    const formats = [ui.extractRaw?.checked ? "原始" : "", ui.extractJson?.checked ? "JSON" : "", ui.extractMarkdown?.checked ? "Markdown" : "", ui.extractWord?.checked ? "Word" : "", ui.extractPdf?.checked ? "PDF" : ""].filter(Boolean).join(" + ");
    ui._extractDirty = false;
    setStatus(`找到 ${entries.length} 个对话${formats ? `｜${formats}` : ""}`, entries.length ? "ok" : "warning");
    return entries;
  }


  function packageBaseNameForExtraction(options, entries) {
    const projectName = options.source === "project" ? (ui?.extractProject?.selectedOptions?.[0]?.textContent || "项目") : "";
    const scope = projectName || options.field || options.folder?.split("/").filter(Boolean).at(-1) || (options.keyword ? `搜索_${options.keyword}` : "对话");
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
    return selectedExtractionEntriesFromCatalog(ui?._extractCatalogEntries || ui?._extractCandidates || [], ui?._extractSelectedIds || new Set());
  }

  function resetExtractionSelection() {
    if (!ui) return;
    ui._extractSelectedIds = new Set();
    ui._extractCandidates = null;
    ui._extractCatalogEntries = null;
    ui._extractDirty = true;
  }

  // —— 2.9.85：记住上次“提取”的拿走方式（输出形式 + 格式勾选）。
  // 筛选条件（来源视图/项目/归档/时间/命名/文件夹/搜索词）每次打开都回到默认，不做记忆。
  const EXTRACT_UI_SELECTS = {
    extractOutputKind: ["zip", "folder"],
  };

  function collectExtractionUiState() {
    if (!ui) return null;
    const selectValue = (element, allowed) => {
      const value = element?.value || "";
      return allowed.includes(value) ? value : allowed[0] || "";
    };
    return {
      schema_version: 1,
      updated_at: new Date().toISOString(),
      formats: {
        raw: ui.extractRaw?.checked === true,
        json: ui.extractJson?.checked !== false,
        markdown: ui.extractMarkdown?.checked !== false,
        word: ui.extractWord?.checked === true,
        pdf: ui.extractPdf?.checked === true,
      },
      output_kind: selectValue(ui.extractOutputKind, EXTRACT_UI_SELECTS.extractOutputKind),
    };
  }

  function saveExtractionUiState() {
    const state = collectExtractionUiState();
    if (!state) return state;
    try { localStorage.setItem(EXTRACT_UI_STATE_KEY, JSON.stringify(state)); } catch { /* 隐私/配额错误忽略，不影响提取 */ }
    return state;
  }

  function readExtractionUiState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(EXTRACT_UI_STATE_KEY) || "null");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }

  function restoreExtractionUiState() {
    if (!ui) return null;
    const state = readExtractionUiState();
    if (!state) return null;
    const enumHas = (key, value) => (EXTRACT_UI_SELECTS[key] || []).includes(value);
    if (ui.extractRaw) ui.extractRaw.checked = state.formats?.raw === true;
    if (ui.extractJson) ui.extractJson.checked = state.formats?.json !== false;
    if (ui.extractMarkdown) ui.extractMarkdown.checked = state.formats?.markdown !== false;
    if (ui.extractWord) ui.extractWord.checked = state.formats?.word === true;
    if (ui.extractPdf) ui.extractPdf.checked = state.formats?.pdf === true;
    if (enumHas("extractOutputKind", state.output_kind) && ui.extractOutputKind) ui.extractOutputKind.value = state.output_kind;
    return state;
  }

  function invalidateExtractionPreview() {
    if (!ui) return;
    ui._extractCandidates = null;
    ui._extractDirty = true;
    if (ui.extractPreviewButton) ui.extractPreviewButton.textContent = "查看筛选结果";
    saveExtractionUiState();
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
    const includeRaw = Boolean(ui.extractRaw?.checked);
    const includeJson = Boolean(ui.extractJson?.checked);
    const includeMarkdown = Boolean(ui.extractMarkdown?.checked);
    const includeWord = Boolean(ui.extractWord?.checked);
    const includePdf = Boolean(ui.extractPdf?.checked);
    if (![includeRaw,includeJson,includeMarkdown,includeWord,includePdf].some(Boolean)) throw new Error("请至少选择一种内容格式");

    const archiveDirectory = await getAuthorizedDirectory(true);
    if (!archiveDirectory.handle) throw new Error(archiveDirectory.reason);
    if (activeTaskRun2983) await attachTaskIo2983(activeTaskRun2983,archiveDirectory.handle);
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
    if (kind === "folder") await getDirectory(archiveDirectory.handle, historyPath, true);

    const addBytes = async (relativePath, bytes) => {
      const path = normalizeStatePath(relativePath);
      if (kind === "zip") zipEntries.push({ name:path, data:bytes instanceof Uint8Array ? bytes : utf8Bytes(bytes) });
      else if (bytes instanceof Uint8Array) await writeBinary(archiveDirectory.handle, joinPath(historyPath, path), bytes);
      else await writeText(archiveDirectory.handle, joinPath(historyPath, path), String(bytes));
    };

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      setStatus(`正在提取 ${index + 1}/${entries.length}\n${entry.title}`, "normal", true);
      if (activeTaskRun2983) {
        taskEvent2983(activeTaskRun2983,{type:"extraction_conversation",stage:"extract",status:"processing",position:index+1,total:entries.length,object_type:"conversation",object_id:String(entry.conversation_id || ""),name:entry.title || null});
        void writeTaskCheckpoint2983(activeTaskRun2983,{phase:"extract",position:index+1,total:entries.length,conversation_id:String(entry.conversation_id || ""),resume_supported:false});
      }
      const item = { conversation_id:entry.conversation_id, title:entry.title, create_time:entry.create_time || null, update_time:entry.update_time || null, classification:entry.classification || null, project_memberships:extractionProjectMemberships(entry), state:extractionStateFromEntry(entry) };
      const sourcePaths = extractionPathsForSource(entry, options);
      const markdownPath = sourcePaths.markdown;
      let markdown = null;
      if (includeMarkdown || includeWord || includePdf) {
        markdown = await readText(archiveDirectory.handle, markdownPath);
        if (markdown === null) throw new Error(`${entry.title} 的 Markdown 不存在：${markdownPath}`);
      }
      if (includeRaw) {
        const rawPath = sourcePaths.raw;
        const rawText = await readText(archiveDirectory.handle, rawPath);
        if (rawText === null) throw new Error(`${entry.title} 的原始档案不存在：${rawPath}`);
        await addBytes(rawPath, rawText); item.raw_path = rawPath;
      }
      if (includeJson) {
        const jsonPath = sourcePaths.json;
        const content = await readText(archiveDirectory.handle, jsonPath);
        if (content === null) throw new Error(`${entry.title} 的 JSON 不存在：${jsonPath}`);
        await addBytes(jsonPath, content); item.json_path = jsonPath;
      }
      if (includeMarkdown) { await addBytes(markdownPath, markdown); item.markdown_path = markdownPath; }
      if (includePdf) {
        const pdfPath = sourcePaths.pdf || pdfPathForMarkdown295(markdownPath);
        let pdfBytes = null;
        try { const handle = await getFileHandle(archiveDirectory.handle, pdfPath, false); pdfBytes = new Uint8Array(await (await handle.getFile()).arrayBuffer()); }
        catch { pdfBytes = await V295.renderMarkdownToPdfBytes(markdown, { title:entry.title || "未命名对话" }); }
        await addBytes(pdfPath, pdfBytes); item.pdf_path = pdfPath;
      }
      if (includeWord) {
        const wordPath = normalizeStatePath(markdownPath).replace(new RegExp(`^${MARKDOWN_ROOT}/`, "i"), "Word/").replace(new RegExp(`^${PROJECT_ROOT}/([^/]+)/${MARKDOWN_ROOT}/`, "i"), "Word/$1/").replace(/\.md$/i, ".docx");
        const docxBytes = V295.renderMarkdownToDocxBytes(markdown, { title:entry.title || "未命名对话" });
        await addBytes(wordPath, docxBytes); item.word_path = wordPath;
      }
      manifestItems.push(item);
    }

    const manifest = {
      schema_version:"1.2", tool_version:VERSION, generated_at:new Date().toISOString(), package_name:baseName,
      filter:{ ...options, time_label:extractionTimeLabel() },
      formats:{ raw:includeRaw, json:includeJson, markdown:includeMarkdown, word:includeWord, pdf:includePdf },
      output:kind, delivery:"quick-entry-plus-history", conversation_count:manifestItems.length, conversations:manifestItems,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    if (kind === "zip") await writeBinary(archiveDirectory.handle, historyPath, createStoreZip(zipEntries));
    const extractionMetaPath = joinPath(EXTRACTION_HISTORY_META_DIR, `${historyName}.json`);
    await writeText(archiveDirectory.handle, extractionMetaPath, manifestText);

    const historyDisplay = `${archiveDirectory.handle.name || "当前资料库"} / ${historyPath}`;
    const result = { historyRoot:archiveDirectory.handle, historyPath, metaPath:extractionMetaPath, kind, baseName, historyDisplay, entryDisplay:entryHandle.name || "快捷入口", entryError:null, conversationCount:entries.length };
    try {
      const entryResult = await syncHistoryToExtractionEntry({ historyRoot:archiveDirectory.handle, historyPath, kind, baseName, entryHandle });
      result.entryDisplay = entryResult.display;
    } catch (error) { result.entryError = error?.message || String(error); }
    ui._lastExtraction = result;
    renderExtractionComplete(result);
    setStatus(result.entryError
      ? `提取历史已经保存，但快捷入口没更新成功。\n${result.entryError}\n历史：${historyDisplay}`
      : `提取完成\n${entries.length} 个对话\n快捷入口已经换成这一次的内容。\n历史：${historyDisplay}`, result.entryError ? "warning" : "ok");
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
    resetExtractionSelection();
    setExtractScene("filter", -1);
    setStatus("可以继续选下一批对话。", "normal");
  }

  async function runViewBackfill295() {
    cancelRequested = false;
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    if (activeTaskRun2983) await attachTaskIo2983(activeTaskRun2983,directory.handle);
    setStatus("正在检查旧资料库视图……\n只读取本地文件，不重新下载网页对话。", "normal", true);
    const result = await backfillLibraryViews295(directory.handle, {
      includePdf: true,
      isCancelled: () => cancelRequested,
      progress: ({ phase, position, total, title, conversation_id }) => {
        const verb = phase === "upgraded" ? "已补齐" : phase === "failed" ? "补齐失败" : "正在检查";
        setStatus(`${verb} ${position}/${total}\n${title || "未命名对话"}\n只读取本地文件，不重新下载网页对话。`, phase === "failed" ? "warning" : "normal", true);
        if (activeTaskRun2983) {
          taskEvent2983(activeTaskRun2983,{type:"view_backfill_conversation",stage:"view-backfill",status:phase === "failed" ? "failed" : phase === "upgraded" ? "complete" : "processing",position,total,object_type:"conversation",object_id:String(conversation_id || title || position),name:title || null});
          void writeTaskCheckpoint2983(activeTaskRun2983,{phase:"view-backfill",position,total,conversation_id:conversation_id || null,resume_supported:false});
        }
      },
    });
    const index = await loadIndex(directory.handle);
    if (index) await refreshConversationStateFromIndex(directory.handle, index);
    const kind = result.failed.length || result.cancelled ? "warning" : "ok";
    setStatus(
      `${result.cancelled ? "新版视图补齐已停止" : "新版视图补齐完成"}\n`
      + `已补齐 ${result.upgraded.length}｜原本完整 ${result.skipped.length}｜失败 ${result.failed.length}\n`
      + `原始 / JSON / Markdown / PDF 均由本地旧档案生成；没有重新下载网页正文。`
      + (result.failed.length ? `\n${result.failed.slice(0, 8).map((item) => `${item.title}：${item.reason}`).join("\n")}` : ""),
      kind,
    );
    return result;
  }

  async function runRebuild() {
    cancelRequested = false;
    const directory = await getAuthorizedDirectory(true);
    if (!directory.handle) throw new Error(directory.reason);
    if (activeTaskRun2983) await attachTaskIo2983(activeTaskRun2983,directory.handle);
    const result = await rebuildIndex(directory.handle, (text) => { setStatus(text, "normal", true); if (activeTaskRun2983) taskEvent2983(activeTaskRun2983,{type:"rebuild_progress",stage:"rebuild-index",status:"processing",message:String(text || "").slice(0,1000)}); });
    const archives = await readIndexedArchives(directory.handle, result.index);
    await writeJson(directory.handle, TIMELINE_PATH, timelineFromArchives(archives.archives));
    await refreshConversationStateFromIndex(directory.handle, result.index);
    setStatus(`本地档案已重新读取\n识别对话 ${Object.keys(result.index.conversations).length} 个\n损坏、未知或非插件 JSON ${result.issues.length} 个${result.issues.length ? `\n${result.issues.slice(0, 12).join("\n")}` : ""}`, result.issues.length ? "warning" : "ok");
  }

  async function runAction(action) {
    if (running && action !== "cancel") return;
    if (action === "cancel") {
      cancelRequested = true;
      if (activeTaskRun2983) taskEvent2983(activeTaskRun2983,{type:"cancel_requested",stage:"cancel",status:"warning",message:"用户请求取消当前任务"});
      setStatus("正在取消；当前文件操作结束后停止……", "warning", true);
      return;
    }
    const taskType2983 = taskTypeForAction2983(action);
    let taskRun2983 = null;
    let taskOutcome2983 = "succeeded";
    let taskError2983 = null;
    if (taskType2983) {
      const initialRoot = ["upgrade-new-directory","upgrade-resolve-conflict"].includes(action) ? null : (cachedDirectoryHandle || null);
      taskRun2983 = createTaskRun2983(taskType2983,{trigger:"user",context:{action,location:String(location?.href || location?.pathname || "")},root:initialRoot});
      activeTaskRun2983 = taskRun2983;
      if (initialRoot) await attachTaskIo2983(taskRun2983,initialRoot);
    }
    running = true;
    updateBusy();
    try {
      if (action === "view-export") setMainView("export");
      else if (action === "view-manage") { setMainView("manage"); await refreshRuleFolderChoices({ interactive:false }); await refreshUserConfigConflicts2984({interactive:false}); updateManageHomeSummary(ui?._folderAudit); }
      else if (action === "view-extract") { resetExtractionSelection(); setMainView("extract"); setExtractScene("filter", -1); updateExtractionOutputDisplay(); await prepareExtractionCatalog({ interactive:false }); }
      else if (action === "manage-home") setManageScene("home",-1);
      else if (action === "manage-rules") { renderClassificationRules(); setManageScene("rules",1); }
      else if (action === "manage-user-config-conflicts") { await refreshUserConfigConflicts2984({interactive:true}); renderUserConfigConflicts2984(); setManageScene("user-config-conflicts",1); }
      else if (action === "config-conflict-keep-current") { await resolveUserConfigConflict2984(ui?._pendingUserConfigConflictId,"keep-current",0); setManageScene("user-config-conflicts",1); }
      else if (action === "config-conflict-use-alternate") { await resolveUserConfigConflict2984(ui?._pendingUserConfigConflictId,"use-alternate",ui?._pendingUserConfigAlternativeIndex || 0); setManageScene("user-config-conflicts",1); }
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
      else if (action === "views-backfill") await runViewBackfill295();
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
        if (!(ui._extractSelectedIds instanceof Set)) ui._extractSelectedIds = new Set();
        for (const input of inputs) {
          input.checked = select;
          if (select) ui._extractSelectedIds.add(String(input.value));
          else ui._extractSelectedIds.delete(String(input.value));
        }
        if (ui.extractSummary) ui.extractSummary.textContent = `找到 ${(ui._extractCandidates || []).length} 个对话｜已选 ${ui._extractSelectedIds.size} 个`;
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
      else if (action === "upgrade-new-directory") await runNewDirectoryUpgrade281(cachedDirectoryHandle);
      else if (action === "upgrade-in-place") await runInPlaceUpgrade281(cachedDirectoryHandle);
      else if (action === "upgrade-resolve-conflict") await applyUpgradeConflictResolution2983(ui?._pendingUpgradeConflictTarget,ui?._pendingUpgradeConflictDecision,ui?._pendingUpgradeConflictSource);
      else if (action === "upgrade-later") { hideLibraryUpgradeWizard281(); setStatus("已暂缓资料库升级；旧目录没有被修改。需要保存或整理时会再次提醒。","warning"); }
      else if (action === "task-logs") await showRecentTaskLogs2983();
      else if (action === "diagnostic-pack") {
        const directory = await getAuthorizedDirectory(true);
        if (!directory.handle) throw new Error(directory.reason || "未获得资料库目录");
        if (taskRun2983) await attachTaskIo2983(taskRun2983,directory.handle);
        const result = await createDiagnosticPack2983(directory.handle,{limit:20});
        setStatus(`诊断包已生成
${result.path}
不包含 Conversation 正文；可以直接把这个 ZIP 发给开发者排查。`,"ok");
      }
      else if (action === "choose") {
        const handle = await chooseDirectory();
        if (taskRun2983) await attachTaskIo2983(taskRun2983,handle);
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
      taskError2983 = error;
      if (error?.code === "LIBRARY_UPGRADE_REQUIRED") {
        taskOutcome2983 = "succeeded_with_warnings";
        setStatus(error.message || "请先完成资料库升级向导。", "warning");
        return;
      }
      if (error?.code === "LIBRARY_UPGRADE_CONFLICT") {
        taskOutcome2983 = "succeeded_with_warnings";
        setStatus(`资料库迁移暂停\n检测到需要你选择的冲突；迁移日志已经保存。请在资料库升级卡片里选择要保留的版本。`, "warning");
        return;
      }
      const cancelled = cancelRequested || /取消|AbortError/.test(`${error?.name} ${error?.message}`);
      taskOutcome2983 = cancelled ? "cancelled" : "failed";
      if (action === "sync") {
        setStatus(cancelled ? `导出已取消
尚未确认安全落盘的内容不会覆盖本地文件。` : `导出失败
${error?.message || error}`,"error");
      } else {
        setStatus(cancelled ? "操作已取消；已经完整保存的文件会保留。" : `操作失败
${error?.message || error}`,cancelled ? "warning" : "error");
      }
    } finally {
      if (taskRun2983) {
        if (taskOutcome2983 === "succeeded" && taskRun2983.lastUiKind === "error") { taskOutcome2983 = "failed"; taskError2983 ||= Object.assign(new Error(taskRun2983.lastStatusText || "任务通过 UI 报告失败"),{code:"ui_reported_error"}); }
        else if (taskOutcome2983 === "succeeded" && taskRun2983.lastUiKind === "warning") taskOutcome2983 = "succeeded_with_warnings";
        await finishTaskRun2983(taskRun2983,taskOutcome2983,{summary:{action,last_status:taskRun2983.lastStatusText || null},error:taskOutcome2983 === "failed" ? taskError2983 : null});
      }
      if (activeTaskRun2983 === taskRun2983) activeTaskRun2983 = null;
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
    if (activeTaskRun2983) {
      activeTaskRun2983.lastUiKind = kind;
      activeTaskRun2983.lastStatusText = String(text || "");
      const signature = `${kind}\u0000${String(text || "")}`;
      if (activeTaskRun2983.lastStatusSignature !== signature || ["warning","error","ok"].includes(kind)) {
        activeTaskRun2983.lastStatusSignature = signature;
        taskEvent2983(activeTaskRun2983,{type:"status",stage:"ui-status",status:kind,message:String(text || "").slice(0,1200)});
      }
    }
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
    const risk=localAuditPolicy2984(audit || {});
    const config=userConfigConflictCounts2984(ui?._userConfigConflictManifest || {});
    const stateCount = changes.length + missing.length + folders.length;
    return {
      state: stateCount,
      organizer: issues.length,
      discoveries: discoveries.length,
      user_config:config.pending,
      blocking:risk.deferred_conversation_ids.length,
      total:Math.max(risk.deferred_conversation_ids.length,stateCount + issues.length) + discoveries.length + config.pending,
    };
  }

  function managementNonblockingCount2984(counts = {}) {
    return Math.max(0,Number(counts?.total || 0)-Number(counts?.blocking || 0)-Number(counts?.user_config || 0));
  }

  function updateManageHomeSummary(audit = ui?._folderAudit) {
    if (!ui?.manageStatusTitle || !ui?.manageStatusCopy) return;
    const configCounts=userConfigConflictCounts2984(ui?._userConfigConflictManifest || {});
    if (!audit && configCounts.pending) {
      ui.manageStatusTitle.textContent = `有 ${configCounts.pending} 项用户设置待确认`;
      ui.manageStatusCopy.textContent = "当前分类规则继续生效，不阻止保存；历史版本已经单独保留。";
      return;
    }
    if (!audit) {
      ui.manageStatusTitle.textContent = "还没有检查本地变化";
      ui.manageStatusCopy.textContent = "在文件管理器里移动、删除或新建目录后，点一次“检查变化”。";
      return;
    }
    const counts = managePendingCounts(audit);
    if (!counts.total) {
      ui.manageStatusTitle.textContent = "文件都整理好了";
      ui.manageStatusCopy.textContent = "JSON 和 Markdown 主视图没有需要你处理的变化；原始与 PDF 会随同步镜像刷新。";
    } else if (counts.blocking) {
      ui.manageStatusTitle.textContent = `还有 ${counts.blocking} 个 Conversation 需要确认`;
      ui.manageStatusCopy.textContent = "只暂停这些 Conversation 的覆盖；其他对话仍然可以正常保存。";
    } else if (counts.user_config) {
      ui.manageStatusTitle.textContent = `有 ${counts.user_config} 项用户设置待确认`;
      ui.manageStatusCopy.textContent = "当前规则继续生效，不阻止保存；历史版本已经单独保留。";
    } else {
      ui.manageStatusTitle.textContent = `发现 ${managementNonblockingCount2984(counts)} 个整理事项`;
      ui.manageStatusCopy.textContent = "这些只是整理建议，不影响导出；可以以后再处理。";
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

  function hostVersion295(host) {
    const direct = String(host?.dataset?.aicfVersion || "").trim();
    if (direct) return direct;
    const text = String(host?.shadowRoot?.querySelector?.(".brand-meta")?.textContent || "");
    return text.match(/\bv(\d+(?:\.\d+){1,3})\b/i)?.[1] || "";
  }

  function compareVersion295(a, b) {
    const left = String(a || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const right = String(b || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const length = Math.max(left.length, right.length, 3);
    for (let i = 0; i < length; i++) {
      const diff = (left[i] || 0) - (right[i] || 0);
      if (diff) return diff < 0 ? -1 : 1;
    }
    return 0;
  }

  function shouldReplaceUiHost295(existingHost, currentVersion = VERSION) {
    if (!existingHost) return false;
    const existingVersion = hostVersion295(existingHost);
    if (!existingVersion) return true;
    return compareVersion295(existingVersion, currentVersion) < 0;
  }

  function createUi() {
    if (ui) return;
    const existingHost = document.getElementById(HOST_ID);
    if (existingHost) {
      if (!shouldReplaceUiHost295(existingHost, VERSION)) return;
      existingHost.remove();
    }
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.dataset.aicfVersion = VERSION;
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
        .upgrade-card{display:grid;gap:10px;margin:0 0 12px;padding:14px;border:1px solid #d9d7ff;border-radius:15px;background:linear-gradient(180deg,#f8f7ff,#fff);box-shadow:0 8px 24px rgba(68,64,186,.08)}.upgrade-card h3{font-size:15px}.upgrade-card p{color:var(--muted);font-size:11px}.upgrade-source{padding:8px 9px;border-radius:9px;background:var(--surface-2);font-size:10.5px;overflow-wrap:anywhere}.upgrade-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.upgrade-actions .recommended{grid-column:1/-1;background:var(--accent);border-color:var(--accent);color:#fff}.upgrade-progress{white-space:pre-wrap;padding:8px 9px;border-radius:9px;background:var(--surface-2);font-size:10.5px}.upgrade-progress[data-kind="warning"]{background:var(--warn-soft);color:var(--warn)}.upgrade-conflicts{display:grid;gap:8px}.upgrade-conflict-item{display:grid;gap:7px;padding:9px;border:1px solid #eedda9;border-radius:10px;background:var(--warn-soft)}.upgrade-conflict-detail{white-space:pre-wrap;overflow-wrap:anywhere;font-size:10px;color:var(--muted)}.upgrade-conflict-actions{display:grid;gap:6px}.upgrade-conflict-actions button{min-height:30px;font-size:10.5px}
        .global-maintenance{margin-top:12px;border:0;background:transparent}.global-maintenance>summary{cursor:pointer;color:var(--muted);font-size:10.5px;padding:7px 2px}.global-maintenance .settings{padding-top:8px}
        @media(prefers-color-scheme:dark){.panel{--bg:#17191e;--surface:#202329;--surface-2:#272a31;--text:#f3f4f6;--muted:#a2a7b2;--line:#343842;--accent:#8580ff;--accent-soft:#2d2b4b;--accent-strong:#aaa6ff;--ok:#69d39c;--ok-soft:#1d2d26;--warn:#f0bc57;--warn-soft:#302819;--danger:#ff8d83;--danger-soft:#33201f}.tabs{background:rgba(32,35,41,.75);border-color:#333741}.location-shell,.entry-card,.format-preview,.issue-preview{border-color:#343842}button:hover{background:#2a2e36;border-color:#454a56}input,select{border-color:#404550}.directory-line,.field,.check{color:#c5c9d1}.upgrade-card{background:linear-gradient(180deg,#252438,#202329);border-color:#41405f}}
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

        <section class="upgrade-card" data-role="upgrade-modal" hidden>
          <div class="eyebrow">资料库升级</div>
          <h3>检测到旧版本资料库</h3>
          <p>目录结构已经升级。推荐新建一个空目录：只迁移插件能够确认由自己创建的资产，旧资料库不会被修改或删除。</p>
          <div class="upgrade-source" data-role="upgrade-source"></div>
          <div class="upgrade-progress" data-role="upgrade-progress"></div>
          <div class="upgrade-conflicts" data-role="upgrade-conflicts" hidden></div>
          <div class="upgrade-actions">
            <button class="recommended" data-action="upgrade-new-directory">新建目录并迁移（推荐）</button>
            <button data-action="upgrade-in-place">当前目录原地升级</button>
            <button data-action="upgrade-later">稍后再说</button>
          </div>
        </section>

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
                    <button class="hub-row" data-action="manage-user-config-conflicts" data-role="user-config-conflict-button" hidden><span class="hub-copy"><strong>用户设置待确认</strong><span>当前分类规则继续生效；历史版本已保留，不影响保存</span></span><span class="count" data-role="user-config-conflict-count">0 项</span><span class="chevron">›</span></button>
                    <button class="hub-row" data-action="manage-ignored" data-role="manage-ignored-button" hidden><span class="hub-copy"><strong>之前忽略的项目</strong><span>需要时可以回来登记</span></span><span class="count" data-role="ignored-count">0 项</span><span class="chevron">›</span></button>
                    <button class="hub-row" data-action="views-backfill"><span class="hub-copy"><strong>补齐新版视图</strong><span>把旧资料库补成 原始 / JSON / Markdown / PDF；只读本地，不重新下载网页正文</span></span><span class="chevron">›</span></button>
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

                <section class="scene" data-manage-scene="user-config-conflicts" hidden>
                  <div class="scene-top"><button class="back-button" data-action="manage-home">‹ 管理</button><span class="progress-pill">不阻断保存</span></div>
                  <section class="scene-card">
                    <div class="scene-title"><span class="scene-kicker">用户管理资产</span><h3>分类规则的历史版本</h3></div>
                    <p class="hero-copy" style="margin-top:6px">这里不会自动吞掉你编辑过的规则。当前版本会一直继续生效，历史候选也会保留，直到你自己确认。</p>
                    <div data-role="user-config-conflict-list" style="margin-top:10px"></div>
                  </section>
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
                    <div class="location-shell"><div class="location-copy"><span class="location-label">当前资料库</span><span class="directory-line" data-role="extract-directory-name">尚未选择本地资料库</span></div></div>
                  </div>
                  <div class="scene-card">
                    <div class="extract-grid">
                      <div class="field wide"><span class="scene-kicker">来源视图</span><div style="display:flex;gap:8px;margin-top:6px"><button type="button" data-action="extract-source-chatgpt" data-role="extract-source-chatgpt" data-active="true">ChatGPT</button><button type="button" data-action="extract-source-project" data-role="extract-source-project" data-active="false">项目</button></div><span class="hint" style="display:block;margin-top:6px">ChatGPT = 00/01/02/03 主视图；项目 = 10_项目里的打包视图。</span></div>
                      <label class="field wide" data-role="extract-project-field" hidden>项目<select data-role="extract-project"><option value="">全部项目</option></select></label>
                      <label class="field">状态<select data-role="extract-state"><option value="active">当前</option><option value="archived">归档</option><option value="all">全部</option></select></label>
                      <label class="field">时间<select data-role="extract-time"><option value="all">全部时间</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="custom">自定义</option></select></label>
                      <label class="field">命名标记<select data-role="extract-field"><option value="">全部命名</option></select></label>
                      <label class="field" data-role="extract-start-field" hidden>开始日期<input type="date" data-role="extract-start" /></label>
                      <label class="field" data-role="extract-end-field" hidden>结束日期<input type="date" data-role="extract-end" /></label>
                      <label class="field wide">文件夹<select data-role="extract-folder"><option value="">全部文件夹</option></select></label>
                      <label class="check wide"><input type="checkbox" data-role="extract-subfolders" checked />包含里面的子文件夹</label>
                      <label class="field wide">搜索<input data-role="extract-keyword" placeholder="标题 / 对话 ID / 命名 / 文件夹" /></label>
                      <div class="wide"><span class="scene-kicker">带哪些文件</span><div style="display:flex;gap:14px;margin-top:6px;flex-wrap:wrap"><label class="check"><input type="checkbox" data-role="extract-raw" />原始</label><label class="check"><input type="checkbox" data-role="extract-json" checked />JSON</label><label class="check"><input type="checkbox" data-role="extract-markdown" checked />Markdown</label><label class="check"><input type="checkbox" data-role="extract-word" />Word</label><label class="check"><input type="checkbox" data-role="extract-pdf" />PDF</label></div><span class="hint" style="display:block;margin-top:6px">Word / PDF 都使用同一份 Markdown 内容母版；公式在 Markdown 保留 LaTeX，导出时渲染。</span></div>
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

        <details class="global-maintenance"><summary>维护与修复</summary><div class="settings"><button data-action="health">检查工具状态</button><button data-action="task-logs">最近任务日志</button><button data-action="diagnostic-pack">导出诊断包</button><button data-action="rebuild">重新读取本地档案</button><button class="btn-danger" data-action="clear">重置工具设置</button></div></details>
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
      userConfigConflictButton:shadow.querySelector('[data-role="user-config-conflict-button"]'), userConfigConflictCount:shadow.querySelector('[data-role="user-config-conflict-count"]'), userConfigConflictList:shadow.querySelector('[data-role="user-config-conflict-list"]'),
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
      upgradeModal:shadow.querySelector('[data-role="upgrade-modal"]'), upgradeSource:shadow.querySelector('[data-role="upgrade-source"]'), upgradeProgress:shadow.querySelector('[data-role="upgrade-progress"]'), upgradeConflicts:shadow.querySelector('[data-role="upgrade-conflicts"]'),
      extractSourceChatgpt:shadow.querySelector('[data-role="extract-source-chatgpt"]'), extractSourceProject:shadow.querySelector('[data-role="extract-source-project"]'), extractProjectField:shadow.querySelector('[data-role="extract-project-field"]'), extractProject:shadow.querySelector('[data-role="extract-project"]'), extractState:shadow.querySelector('[data-role="extract-state"]'), extractTime:shadow.querySelector('[data-role="extract-time"]'), extractField:shadow.querySelector('[data-role="extract-field"]'), extractStartField:shadow.querySelector('[data-role="extract-start-field"]'), extractEndField:shadow.querySelector('[data-role="extract-end-field"]'),
      extractStart:shadow.querySelector('[data-role="extract-start"]'), extractEnd:shadow.querySelector('[data-role="extract-end"]'), extractFolder:shadow.querySelector('[data-role="extract-folder"]'), extractIncludeSubfolders:shadow.querySelector('[data-role="extract-subfolders"]'),
      extractKeyword:shadow.querySelector('[data-role="extract-keyword"]'), extractRaw:shadow.querySelector('[data-role="extract-raw"]'), extractJson:shadow.querySelector('[data-role="extract-json"]'), extractMarkdown:shadow.querySelector('[data-role="extract-markdown"]'), extractWord:shadow.querySelector('[data-role="extract-word"]'), extractPdf:shadow.querySelector('[data-role="extract-pdf"]'), extractOutputKind:shadow.querySelector('[data-role="extract-output-kind"]'), extractPackageName:shadow.querySelector('[data-role="extract-package-name"]'),
      extractEntryLocation:shadow.querySelector('[data-role="extract-entry-location"]'), extractHistoryLocation:shadow.querySelector('[data-role="extract-history-location"]'), extractPreviewButton:shadow.querySelector('[data-role="extract-preview-button"]'),
      extractResults:shadow.querySelector('[data-role="extract-results"]'), extractSummary:shadow.querySelector('[data-role="extract-summary"]'), extractList:shadow.querySelector('[data-role="extract-list"]'), extractComplete:shadow.querySelector('[data-role="extract-complete"]'), extractCompleteText:shadow.querySelector('[data-role="extract-complete-text"]'), extractDeleteHistoryButton:shadow.querySelector('[data-role="extract-delete-history"]'),
      _pendingDeleteRuleId:"",_pendingEditRuleId:"",_pendingFolderPath:"",_pendingConversationId:"",_pendingCandidateIndex:"",_pendingIgnoredFolder:"",_pendingIgnoredTitleIndex:"",_pendingUserConfigConflictId:"",_pendingUserConfigAlternativeIndex:0,
      _editingRuleId:"",_upgradeProbe:null,_upgradeConflictContext:null,_pendingUpgradeConflictTarget:"",_pendingUpgradeConflictDecision:"",_pendingUpgradeConflictSource:"",_discoveredFolderPath:"",_folderAudit:null,_userConfigConflictManifest:{schema_version:"1.0",conflicts:[]},_remoteRuleCandidates:[],_ruleFolderPaths:[],_extractCandidates:null,_extractCatalogEntries:null,_extractSelectedIds:new Set(),_extractIndex:null,_extractDirty:true,_extractEntryHandle:null,_lastExtraction:null,_extractSourceMode:"chatgpt",
      _mainView:"export",_manageScene:"home",_extractScene:"filter",_ruleReturnScene:"rules",_panelAnimation:null,_viewResizeObserver:null,
    };

    renderClassificationRules();
    renderIgnoredItems();
    updateRulePreview();
    updateManageHomeSummary();
    setMainView("export");
    updateDirectoryDisplay();
    updateExtractionOutputDisplay();
    restoreExtractionUiState();

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
      if (button.dataset.action === "extract-source-chatgpt") { setExtractionSourceMode("chatgpt"); return; }
      if (button.dataset.action === "extract-source-project") { setExtractionSourceMode("project"); return; }
      if (button.dataset.action === "ignore-restore-title" || button.dataset.action === "ignore-register-title") ui._pendingIgnoredTitleIndex = button.dataset.ignoreIndex || "";
      if (["config-conflict-keep-current","config-conflict-use-alternate"].includes(button.dataset.action)) { ui._pendingUserConfigConflictId=button.dataset.conflictId || ""; ui._pendingUserConfigAlternativeIndex=Number(button.dataset.alternativeIndex || 0) || 0; }
      if (button.dataset.action === "upgrade-resolve-conflict") {
        ui._pendingUpgradeConflictTarget = button.dataset.targetPath || "";
        ui._pendingUpgradeConflictDecision = button.dataset.decision || "";
        ui._pendingUpgradeConflictSource = button.dataset.sourcePath || "";
      }
      runAction(button.dataset.action);
    });
    shadow.addEventListener("input", (event) => {
      if (event.target === ui.ruleRootFolder) populateRuleSubfolderChoices();
      if (event.target.matches("[data-role^='rule-']")) updateRulePreview();
      if ([ui.extractStart,ui.extractEnd,ui.extractKeyword].includes(event.target)) invalidateExtractionPreview();
    });
    shadow.addEventListener("change", (event) => {
      if (event.target?.matches?.('[data-role="extract-select"]')) {
        if (!(ui._extractSelectedIds instanceof Set)) ui._extractSelectedIds = new Set();
        const id = String(event.target.value || "");
        if (event.target.checked) ui._extractSelectedIds.add(id); else ui._extractSelectedIds.delete(id);
        if (ui.extractSummary) ui.extractSummary.textContent = `找到 ${(ui._extractCandidates || []).length} 个对话｜已选 ${ui._extractSelectedIds.size} 个`;
      }
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
      if (event.target === ui.extractProject && ui._extractSourceMode === "project") ui._extractSelectedIds = new Set();
      if ([ui.extractProject,ui.extractState,ui.extractTime,ui.extractField,ui.extractFolder,ui.extractIncludeSubfolders,ui.extractRaw,ui.extractJson,ui.extractMarkdown,ui.extractWord,ui.extractPdf,ui.extractOutputKind].includes(event.target)) invalidateExtractionPreview();
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
        if (handle) verifyPermission(handle, false).then((ok) => ok ? maybePromptLibraryUpgrade281(handle) : null).catch(() => {});
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


