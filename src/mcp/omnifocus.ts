import { z } from "zod";
import { DateTime } from "luxon";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import config from "@/config";
import {
  describePerspective,
  findPerspective,
  omnifocus,
  Model,
  perspectiveFilter,
  rankAfter,
  TaskChanges,
  taskDate,
  TaskView,
} from "@/clients";
import { json } from "./util";

const NOTE_PREVIEW = 500;
const DATE_HELP =
  "ISO 8601. A date alone gets the default time from the user's OmniFocus settings (5 PM for due dates unless " +
  `changed); a time without an offset is in the user's time zone (${config.omnifocus.timezone}).`;

function client() {
  if (!omnifocus) throw new Error("OmniFocus is not configured (OMNIFOCUS_USERNAME and OMNIFOCUS_PASSWORD).");
  return omnifocus;
}

function iso(d: DateTime | null) {
  return d?.toISO({ suppressMilliseconds: true }) ?? undefined;
}

function parseDate(input: string, model: Model) {
  return DateTime.fromISO(taskDate(input, "00:00", model.zone), { zone: model.zone });
}

/** Drops empty and false fields, to keep results short. */
function compact<T extends Record<string, unknown>>(obj: T) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && !v.length)),
  );
}

function summarize(task: TaskView, model: Model) {
  const parent = task.parentId && task.parentId !== task.projectId ? model.tasks.get(task.parentId) : undefined;
  return compact({
    id: task.id,
    name: task.name,
    status: task.status,
    projectStatus: task.projectStatus,
    available: task.status === "remaining" ? task.available : undefined,
    blocked: task.status === "remaining" && task.blocked,
    deferred: task.status === "remaining" && task.deferred,
    inbox: task.inbox,
    project: task.isProject ? undefined : task.projectName,
    folder: task.folderPath,
    parentTask: parent?.name,
    tags: task.tags,
    flagged: task.effectivelyFlagged,
    due: iso(task.due),
    overdue: task.status === "remaining" && !!task.due && task.due < model.now,
    defer: iso(task.defer),
    planned: iso(task.planned),
    completed: iso(task.completed),
    dropped: iso(task.dropped),
    estimatedMinutes: task.estimatedMinutes,
    repeat: task.repeat,
    subtasks: task.childIds.length || undefined,
    note: task.note && task.note.length > NOTE_PREVIEW ? `${task.note.slice(0, NOTE_PREVIEW)}…` : task.note,
  });
}

function ambiguous(kind: string, input: string, options: string[]): never {
  throw new Error(`"${input}" matches ${options.length} ${kind}s; use an ID instead:\n${options.join("\n")}`);
}

/** Finds a project by ID, name, or "Folder / Name" path, preferring ones which aren't completed or dropped. */
function resolveProject(model: Model, input: string): TaskView {
  const byId = model.tasks.get(input);
  if (byId?.isProject) return byId;
  const needle = input.trim().toLowerCase();
  const matches = [...model.tasks.values()].filter(
    (t) =>
      t.isProject &&
      (t.name.toLowerCase() === needle || `${t.folderPath ?? ""} / ${t.name}`.toLowerCase().endsWith(needle)),
  );
  const remaining = matches.filter((t) => t.status === "remaining");
  const candidates = remaining.length ? remaining : matches;
  if (candidates.length === 0) throw new Error(`No OmniFocus project named "${input}".`);
  if (candidates.length > 1)
    ambiguous("project", input, candidates.map((p) => `${p.id}: ${p.folderPath ? `${p.folderPath} / ` : ""}${p.name}`));
  return candidates[0];
}

/** Finds a tag by ID, full path ("Parent / Child"), or name. */
function resolveTag(model: Model, input: string) {
  if (model.tags.has(input)) return model.tags.get(input)!;
  const needle = input.trim().toLowerCase();
  const tags = [...model.tags.values()];
  const byPath = tags.filter((t) => t.path.toLowerCase() === needle);
  const matches = byPath.length ? byPath : tags.filter((t) => t.name.toLowerCase() === needle);
  const active = matches.filter((t) => t.status !== "dropped");
  const candidates = active.length ? active : matches;
  if (candidates.length === 0) throw new Error(`No OmniFocus tag named "${input}".`);
  if (candidates.length > 1) ambiguous("tag", input, candidates.map((t) => `${t.id}: ${t.path}`));
  return candidates[0];
}

/** Finds a folder by ID, full path, or name; returns its path. */
function resolveFolder(model: Model, input: string): string {
  return model.folders.get(resolveFolderId(model, input))!.path;
}

/** Finds a folder by ID, full path, or name; returns its ID. */
function resolveFolderId(model: Model, input: string): string {
  if (model.folders.has(input)) return input;
  const needle = input.trim().toLowerCase();
  const folders = [...model.folders.values()];
  const byPath = folders.filter((f) => f.path.toLowerCase() === needle);
  const matches = byPath.length ? byPath : folders.filter((f) => f.name.toLowerCase() === needle);
  if (matches.length === 0) throw new Error(`No OmniFocus folder named "${input}".`);
  if (matches.length > 1) ambiguous("folder", input, matches.map((f) => `${f.id}: ${f.path}`));
  return matches[0].id;
}

function inFolder(path: string | null, folder: string) {
  return !!path && (path === folder || path.startsWith(`${folder} / `));
}

const byDueThenOrder = (a: TaskView, b: TaskView) =>
  (a.due ? +a.due : Infinity) - (b.due ? +b.due : Infinity) ||
  Number(b.effectivelyFlagged) - Number(a.effectivelyFlagged) ||
  (a.projectName ?? "").localeCompare(b.projectName ?? "") ||
  a.rank - b.rank;

const byCompletedDesc = (a: TaskView, b: TaskView) =>
  (b.completed ? +b.completed : 0) - (a.completed ? +a.completed : 0);

const byChangedDesc = (a: TaskView, b: TaskView) => (b.modified ? +b.modified : 0) - (a.modified ? +a.modified : 0);

export function registerOmniFocusTools(server: McpServer) {
  server.registerTool(
    "omnifocus_list_tasks",
    {
      title: "List OmniFocus tasks",
      description:
        "Lists OmniFocus tasks matching every filter given, synced live from the Omni Sync Server. Pass a " +
        "`perspective` (see omnifocus_list_perspectives) to get what it shows, optionally narrowed by other filters. " +
        "Or combine filters directly: the inbox is `inbox: true`; Flagged is `flagged: true`; Forecast is " +
        "`due: 'overdue_or_soon'`; a tag or project perspective is `tag` or `project`; completed tasks are " +
        "`status: 'completed'`. Dates are ISO 8601 in the user's time zone, and include any inherited from the " +
        "task's project or parent task.",
      inputSchema: {
        perspective: z
          .string()
          .optional()
          .describe("A built-in or custom perspective's name or ID. Its own rules decide which tasks are included."),
        status: z
          .enum(["remaining", "available", "completed", "dropped", "all"])
          .optional()
          .describe(
            "remaining: not completed or dropped (unchecked). available: remaining, and neither deferred nor " +
              "blocked by a sequential project, an on-hold project, or an on-hold tag. completed: checked off. " +
              "Completed results are newest first. Defaults to remaining, or to whatever the perspective shows.",
          ),
        inbox: z.boolean().optional().describe("Only tasks in the inbox (true), or only tasks not in it (false)."),
        project: z.string().optional().describe("Only tasks in this project: its name, 'Folder / Name', or ID."),
        folder: z.string().optional().describe("Only tasks in projects within this folder or its subfolders."),
        tag: z.string().optional().describe("Only tasks with this tag or one of its child tags: name, path, or ID."),
        flagged: z.boolean().optional().describe("Only flagged tasks, including those in flagged projects or groups."),
        due: z
          .enum(["overdue", "soon", "overdue_or_soon", "any", "none"])
          .optional()
          .describe(
            "overdue: due date has passed. soon: due between now and the database's 'due soon' cutoff (default 2 " +
              "days). overdue_or_soon: either. any: has a due date. none: has no due date.",
          ),
        due_before: z.string().optional().describe("Only tasks due before this ISO 8601 date or time."),
        due_after: z.string().optional().describe("Only tasks due after this ISO 8601 date or time."),
        deferred: z
          .boolean()
          .optional()
          .describe("Only tasks whose defer date hasn't arrived yet (true), or only tasks which aren't deferred (false)."),
        completed_after: z.string().optional().describe("Only tasks completed after this ISO 8601 date or time."),
        search: z.string().optional().describe("Case-insensitive text to find in the task's name or note."),
        include_projects: z.boolean().default(false).describe("Include projects themselves, not just their tasks."),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const model = await client().sync();
      const perspective = args.perspective ? findPerspective(model.perspectives, args.perspective) : undefined;
      const view = perspective ? perspectiveFilter(model, perspective) : undefined;
      const status = args.status ?? (perspective ? "all" : "remaining");
      const projectId = args.project ? resolveProject(model, args.project).id : undefined;
      const folder = args.folder ? resolveFolder(model, args.folder) : undefined;
      const tagIds = args.tag ? model.tagWithDescendants(resolveTag(model, args.tag).id) : undefined;
      const dueBefore = args.due_before ? parseDate(args.due_before, model) : undefined;
      const dueAfter = args.due_after ? parseDate(args.due_after, model) : undefined;
      const completedAfter = args.completed_after ? parseDate(args.completed_after, model) : undefined;
      const search = args.search?.toLowerCase();

      const tasks = [...model.tasks.values()].filter((t) => {
        if (t.isProject && !args.include_projects && !view?.includesProjects) return false;
        if (view && !view.matches(t)) return false;
        if (status === "available" ? !t.available : status !== "all" && t.status !== status) return false;
        if (args.inbox !== undefined && t.inbox !== args.inbox) return false;
        if (projectId && t.projectId !== projectId) return false;
        if (folder && !inFolder(t.folderPath, folder)) return false;
        if (tagIds && !t.tagIds.some((id) => tagIds.has(id))) return false;
        if (args.flagged !== undefined && t.effectivelyFlagged !== args.flagged) return false;
        if (args.due === "overdue" && !(t.due && t.due < model.now)) return false;
        if (args.due === "soon" && !(t.due && t.due >= model.now && t.due <= model.dueSoon)) return false;
        if (args.due === "overdue_or_soon" && !(t.due && t.due <= model.dueSoon)) return false;
        if (args.due === "any" && !t.due) return false;
        if (args.due === "none" && t.due) return false;
        if (dueBefore && !(t.due && t.due < dueBefore)) return false;
        if (dueAfter && !(t.due && t.due > dueAfter)) return false;
        if (args.deferred !== undefined && t.deferred !== args.deferred) return false;
        if (completedAfter && !(t.completed && t.completed > completedAfter)) return false;
        if (search && !`${t.name}\n${t.note ?? ""}`.toLowerCase().includes(search)) return false;
        return true;
      });
      tasks.sort(
        perspective?.byChanged ? byChangedDesc
        : status === "completed" || perspective?.rules.some((r) => r.actionAvailability === "completed") ? byCompletedDesc
        : byDueThenOrder,
      );

      return json({
        perspective: perspective ? { name: perspective.name, shows: describePerspective(model, perspective) } : undefined,
        total: tasks.length,
        offset: args.offset,
        now: iso(model.now),
        dueSoonCutoff: args.due === "soon" || args.due === "overdue_or_soon" ? iso(model.dueSoon) : undefined,
        tasks: tasks.slice(args.offset, args.offset + args.limit).map((t) => summarize(t, model)),
      });
    },
  );

  server.registerTool(
    "omnifocus_list_perspectives",
    {
      title: "List OmniFocus perspectives",
      description:
        "Lists the built-in and custom perspectives, with what each one shows. Pass a name to omnifocus_list_tasks " +
        "as `perspective` to get its tasks.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const model = await client().sync();
      return json({
        perspectives: model.perspectives.map((p) => {
          let unsupported: string | undefined;
          try {
            perspectiveFilter(model, p);
          } catch (ex) {
            unsupported = (ex as Error).message;
          }
          return compact({ id: p.id, name: p.name, custom: !p.builtIn, shows: describePerspective(model, p), unsupported });
        }),
      });
    },
  );

  server.registerTool(
    "omnifocus_list_projects",
    {
      title: "List OmniFocus projects",
      description: "Lists OmniFocus projects with their folder, status, and how many tasks remain.",
      inputSchema: {
        status: z
          .enum(["remaining", "active", "on_hold", "completed", "dropped", "all"])
          .default("remaining")
          .describe("remaining: active or on hold."),
        folder: z.string().optional().describe("Only projects within this folder or its subfolders."),
        search: z.string().optional().describe("Case-insensitive text to find in the project's name."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, folder, search }) => {
      const model = await client().sync();
      const folderPath = folder ? resolveFolder(model, folder) : undefined;
      const projects = [...model.tasks.values()]
        .filter(
          (p) =>
            p.isProject &&
            (status === "all" ||
              (status === "remaining" ? p.status === "remaining" : p.projectStatus === status)) &&
            (!folderPath || inFolder(p.folderPath, folderPath)) &&
            (!search || p.name.toLowerCase().includes(search.toLowerCase())),
        )
        .sort((a, b) => (a.folderPath ?? "").localeCompare(b.folderPath ?? "") || a.rank - b.rank);

      return json({
        total: projects.length,
        projects: projects.map((p) => {
          const tasks = model.descendants(p.id).slice(1);
          return {
            ...summarize(p, model),
            type: p.sequential ? "sequential" : "parallel",
            remainingTasks: tasks.filter((t) => t.status === "remaining").length,
            availableTasks: tasks.filter((t) => t.available).length,
          };
        }),
      });
    },
  );

  server.registerTool(
    "omnifocus_list_tags",
    {
      title: "List OmniFocus tags",
      description: "Lists OmniFocus tags by their full path (e.g. 'Errands / Hardware Store'), with task counts.",
      inputSchema: {
        include_dropped: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ include_dropped }) => {
      const model = await client().sync();
      const remaining = [...model.tasks.values()].filter((t) => t.status === "remaining" && !t.isProject);
      const tags = [...model.tags.values()]
        .filter((t) => include_dropped || t.status !== "dropped")
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((tag) => {
          const tasks = remaining.filter((t) => t.tagIds.includes(tag.id));
          return {
            id: tag.id,
            path: tag.path,
            status: tag.status,
            remainingTasks: tasks.length,
            availableTasks: tasks.filter((t) => t.available).length,
          };
        });
      return json({ total: tags.length, tags });
    },
  );

  server.registerTool(
    "omnifocus_add_task",
    {
      title: "Add OmniFocus task",
      description:
        "Adds a task to OmniFocus: to the inbox by default, or to the end of a project or under another task. It " +
        "appears on the user's devices at their next sync.",
      inputSchema: {
        name: z.string().min(1),
        note: z.string().optional(),
        project: z
          .string()
          .optional()
          .describe("Project name, 'Folder / Name', or ID; or a task ID to make this a subtask. Defaults to the inbox."),
        tags: z.array(z.string()).default([]).describe("Tag names, paths, or IDs. The tags must already exist."),
        due: z.string().optional().describe(`Due date. ${DATE_HELP}`),
        defer: z.string().optional().describe(`Defer date, when the task becomes available. ${DATE_HELP}`),
        planned: z.string().optional().describe(`Planned date, when the user intends to work on it. ${DATE_HELP}`),
        flagged: z.boolean().default(false),
        estimated_minutes: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, note, project, tags, due, defer, planned, flagged, estimated_minutes }) => {
      const of = client();
      // Resolve everything before writing, so a typo doesn't leave a half-filed task.
      const model = await of.sync();
      let parentId: string | undefined;
      if (project) {
        const task = model.tasks.get(project);
        const parent = task && !task.isProject ? task : resolveProject(model, project);
        if (parent.status !== "remaining")
          throw new Error(`"${parent.name}" is ${parent.status}; add the task somewhere else.`);
        parentId = parent.id;
      }
      const tagIds = [...new Set(tags.map((t) => resolveTag(model, t).id))];

      const { id, model: updated } = await of.addTask({
        name,
        note,
        parentId,
        tagIds,
        due: due ? taskDate(due, model.defaultTimes.due, model.zone) : undefined,
        defer: defer ? taskDate(defer, model.defaultTimes.defer, model.zone) : undefined,
        planned: planned ? taskDate(planned, model.defaultTimes.planned, model.zone) : undefined,
        flagged,
        estimatedMinutes: estimated_minutes,
        rank: (m) =>
          rankAfter(
            [...m.tasks.values()]
              .filter((t) => (parentId ? t.parentId === parentId : t.inbox && !t.parentId))
              .map((t) => t.rank),
          ),
      });
      return json({ created: summarize(updated.tasks.get(id)!, updated) });
    },
  );

  server.registerTool(
    "omnifocus_edit_task",
    {
      title: "Edit OmniFocus task",
      description:
        "Changes fields on an existing task or project. Only the fields given change. Get IDs from " +
        "omnifocus_list_tasks or omnifocus_list_projects. To check a task off, use omnifocus_complete_tasks.",
      inputSchema: {
        id: z.string().describe("ID of the task or project."),
        name: z.string().min(1).optional(),
        note: z.string().optional().describe("Replaces the whole note. An empty string clears it."),
        flagged: z.boolean().optional(),
        due: z.string().nullable().optional().describe(`New due date, or null or "" to clear it. ${DATE_HELP}`),
        defer: z.string().nullable().optional().describe(`New defer date, or null or "" to clear it. ${DATE_HELP}`),
        planned: z.string().nullable().optional().describe(`New planned date, or null or "" to clear it. ${DATE_HELP}`),
        estimated_minutes: z.number().int().min(0).nullable().optional().describe("Null or 0 clears it."),
        tags: z.array(z.string()).optional().describe("Replaces all of its tags: names, paths, or IDs. [] removes them all."),
        add_tags: z.array(z.string()).optional().describe("Tags to add, keeping the others."),
        remove_tags: z.array(z.string()).optional().describe("Tags to remove, keeping the others."),
        move_to: z
          .string()
          .optional()
          .describe("Tasks only: a project's name, 'Folder / Name', or ID; a task ID to nest it under; or 'inbox'."),
        folder: z
          .string()
          .nullable()
          .optional()
          .describe("Projects only: a folder's name, path, or ID to move it to, or null for the top level."),
        type: z
          .enum(["sequential", "parallel", "single_actions"])
          .optional()
          .describe("How its subtasks are worked through. single_actions is for projects only."),
        complete_with_last_action: z
          .boolean()
          .optional()
          .describe("Whether completing its last remaining subtask completes it too."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      const of = client();
      // Resolve names first, so a typo fails before anything is written.
      const model = await of.sync();
      const task = model.tasks.get(args.id);
      if (!task) throw new Error(`No OmniFocus task with ID ${args.id}.`);
      const clear = (v: string | null | undefined) => (v === null || v === "" ? null : v);
      const changes: TaskChanges = {};

      if (args.name !== undefined) changes.name = args.name;
      if (args.note !== undefined) changes.note = clear(args.note);
      if (args.flagged !== undefined) changes.flagged = args.flagged;
      for (const [field, time] of [["due", model.defaultTimes.due], ["defer", model.defaultTimes.defer], ["planned", model.defaultTimes.planned]] as const) {
        const value = args[field];
        if (value !== undefined) changes[field] = clear(value) === null ? null : taskDate(value!, time, model.zone);
      }
      if (args.estimated_minutes !== undefined) changes.estimatedMinutes = args.estimated_minutes || null;
      if (args.tags || args.add_tags || args.remove_tags) {
        const ids = (names?: string[]) => names?.map((t) => resolveTag(model, t).id);
        changes.tags = { set: ids(args.tags), add: ids(args.add_tags), remove: ids(args.remove_tags) };
      }
      if (args.move_to !== undefined) {
        if (task.isProject) throw new Error(`"${task.name}" is a project; use folder to move it.`);
        if (args.move_to.trim().toLowerCase() === "inbox") changes.parentId = null;
        else {
          const target = model.tasks.get(args.move_to);
          const parent = target && !target.isProject ? target : resolveProject(model, args.move_to);
          if (model.descendants(task.id).some((t) => t.id === parent.id))
            throw new Error(`Can't move "${task.name}" inside itself.`);
          if (parent.status !== "remaining") throw new Error(`"${parent.name}" is ${parent.status}; move it somewhere else.`);
          changes.parentId = parent.id;
        }
      }
      if (args.folder !== undefined) {
        if (!task.isProject) throw new Error(`"${task.name}" isn't a project; use move_to to move it.`);
        changes.folderId = args.folder === null || args.folder === "" ? null : resolveFolderId(model, args.folder);
      }
      if (args.type !== undefined) {
        if (args.type === "single_actions" && !task.isProject)
          throw new Error(`Only projects can be single-action lists; "${task.name}" is a task.`);
        changes.type = args.type;
      }
      if (args.complete_with_last_action !== undefined) changes.completeWithLastAction = args.complete_with_last_action;
      if (!Object.keys(changes).length) throw new Error("Nothing to change; give at least one field.");

      const updated = await of.editTask(args.id, changes, (latest) => {
        if (!latest.tasks.has(args.id)) throw new Error(`Task ${args.id} was deleted before it could be edited.`);
      });
      return json({ updated: summarize(updated.tasks.get(args.id)!, updated), changed: Object.keys(changes) });
    },
  );

  server.registerTool(
    "omnifocus_complete_tasks",
    {
      title: "Complete OmniFocus tasks",
      description:
        "Marks tasks complete, as checking them off in OmniFocus does: remaining subtasks are completed too, a parent " +
        "task or project set to complete with its last action is completed with it, and a repeating task (and its " +
        "subtasks) moves to its next repetition, leaving a completed copy behind. Get IDs from omnifocus_list_tasks. " +
        "Projects can't be completed directly.",
      inputSchema: {
        ids: z.array(z.string()).min(1).max(100).describe("IDs of the tasks to complete."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ ids }) => {
      const repeating = new Set<string>();
      const { model: updated, alsoCompleted } = await client().completeTasks(ids, (model, id) => {
        const task = model.tasks.get(id);
        if (!task) throw new Error(`No OmniFocus task with ID ${id}.`);
        if (task.isProject) throw new Error(`"${task.name}" is a project; complete it in OmniFocus.`);
        if (task.status !== "remaining") throw new Error(`"${task.name}" is already ${task.status}.`);
        const repeatingSubtask = model.descendants(id).slice(1).find((t) => t.status === "remaining" && t.repeat);
        if (repeatingSubtask)
          throw new Error(`"${repeatingSubtask.name}" inside "${task.name}" repeats; complete it on its own first.`);
        if (task.repeat) repeating.add(id);
      });
      return json({
        completed: ids.map((id) => {
          const task = updated.tasks.get(id)!;
          if (repeating.has(id) && task.status === "remaining")
            return compact({ id, name: task.name, repeats: true, nextDue: iso(task.due), nextDefer: iso(task.defer), nextPlanned: iso(task.planned) });
          const subtasks = updated.descendants(id).slice(1).filter((t) => +t.completed! === +task.completed!);
          return compact({ id, name: task.name, completed: iso(task.completed), subtasksCompleted: subtasks.length });
        }),
        alsoCompleted: alsoCompleted.length
          ? alsoCompleted.map((id) => {
              const task = updated.tasks.get(id)!;
              return compact({
                id,
                name: task.name,
                type: task.isProject ? "project" : "task",
                reason: "completed with its last action",
                nextDue: task.status === "remaining" ? iso(task.due) : undefined,
              });
            })
          : undefined,
      });
    },
  );
}
