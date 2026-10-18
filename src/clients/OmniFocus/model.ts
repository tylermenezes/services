import { DateTime } from "luxon";
import { bool, Database, Fields, idref, int, noteText, text } from "./database";
import { Perspective, perspectives } from "./perspectives";

const DEFAULT_DUE_SOON_SECONDS = 2 * 24 * 60 * 60;

export type TaskStatus = "remaining" | "completed" | "dropped";
export type ProjectStatus = "active" | "on_hold" | "completed" | "dropped";
export type TagStatus = "active" | "on_hold" | "dropped";

export interface TaskView {
  id: string;
  name: string;
  note: string | null;
  isProject: boolean;
  status: TaskStatus;
  /** For projects only. */
  projectStatus: ProjectStatus | null;
  /** Remaining, not deferred, and not blocked by a sequential parent, an on-hold project, or an on-hold tag. */
  available: boolean;
  blocked: boolean;
  deferred: boolean;
  inbox: boolean;
  flagged: boolean;
  /** Flagged itself, or inside a flagged task or project. */
  effectivelyFlagged: boolean;
  parentId: string | null;
  projectId: string | null;
  projectName: string | null;
  folderId: string | null;
  folderPath: string | null;
  tagIds: string[];
  tags: string[];
  /** Effective dates, which include any inherited from containing tasks and projects. */
  due: DateTime | null;
  defer: DateTime | null;
  planned: DateTime | null;
  completed: DateTime | null;
  dropped: DateTime | null;
  added: DateTime | null;
  modified: DateTime | null;
  estimatedMinutes: number | null;
  repeat: string | null;
  /** For projects only. */
  nextReview: DateTime | null;
  /** For projects only: a single-action list. */
  singleActions: boolean;
  sequential: boolean;
  rank: number;
  childIds: string[];
}

export interface TagView {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  status: TagStatus;
}

export interface FolderView {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  dropped: boolean;
}

/** A `<hidden>` element is a date on newer databases and a boolean on older ones; either way it means dropped. */
function isHidden(fields: Fields) {
  const v = text(fields, "hidden");
  return v !== null && v !== "false";
}

/** A read-only view of a database at a point in time, with each task's effective status. */
export class Model {
  readonly tasks = new Map<string, TaskView>();
  readonly tags = new Map<string, TagView>();
  readonly folders = new Map<string, FolderView>();
  readonly perspectives: Perspective[];
  readonly dueSoon: DateTime;

  constructor(
    private db: Database,
    readonly now: DateTime,
    readonly zone: string,
  ) {
    this.buildFolders();
    this.buildTags();
    this.buildTasks();
    this.dueSoon = now.plus({ seconds: this.dueSoonSeconds() });
    this.perspectives = perspectives(db);
  }

  date(value: string | null): DateTime | null {
    if (!value) return null;
    // Dates without an offset are "floating" local times.
    const dt = DateTime.fromISO(value, { zone: this.zone });
    return dt.isValid ? dt : null;
  }

  private dueSoonSeconds(): number {
    const setting = this.db.objects.setting.get("DueSoonInterval");
    const plist = setting?.plist as Fields | undefined;
    const value = plist && Number(text(plist, "integer") ?? text(plist, "real"));
    return value && value > 0 ? value : DEFAULT_DUE_SOON_SECONDS;
  }

  private buildFolders() {
    const paths = new Map<string, string>();
    const pathOf = (id: string, seen = new Set<string>()): string => {
      if (paths.has(id)) return paths.get(id)!;
      const fields = this.db.folders.get(id);
      if (!fields || seen.has(id)) return "";
      seen.add(id);
      const parent = idref(fields, "folder");
      const name = text(fields, "name") ?? "";
      const path = parent && this.db.folders.has(parent) ? `${pathOf(parent, seen)} / ${name}` : name;
      paths.set(id, path);
      return path;
    };
    for (const [id, fields] of this.db.folders) {
      const parentId = idref(fields, "folder");
      this.folders.set(id, { id, name: text(fields, "name") ?? "", path: pathOf(id), parentId, dropped: isHidden(fields) });
    }
    // Dropping a folder drops everything in it.
    for (const folder of this.folders.values()) {
      for (let p = folder.parentId, seen = new Set<string>(); p && !seen.has(p); p = this.folders.get(p)?.parentId ?? null) {
        seen.add(p);
        if (this.folders.get(p)?.dropped) folder.dropped = true;
      }
    }
  }

  private buildTags() {
    const raw = this.db.tags;
    const resolve = (id: string, seen = new Set<string>()): TagView | null => {
      if (this.tags.has(id)) return this.tags.get(id)!;
      const fields = raw.get(id);
      if (!fields || seen.has(id)) return null;
      seen.add(id);
      const parentId = idref(fields, "context");
      const parent = parentId ? resolve(parentId, seen) : null;
      const name = text(fields, "name") ?? "";
      const own: TagStatus = isHidden(fields) ? "dropped" : bool(fields, "prohibits-next-action") ? "on_hold" : "active";
      // A tag is as restricted as its most restricted ancestor.
      const rank = { active: 0, on_hold: 1, dropped: 2 };
      const status = parent && rank[parent.status] > rank[own] ? parent.status : own;
      const tag = { id, name, path: parent ? `${parent.path} / ${name}` : name, parentId, status };
      this.tags.set(id, tag);
      return tag;
    };
    for (const id of raw.keys()) resolve(id);
  }

  private buildTasks() {
    const raw = this.db.tasks;
    const taskTags = this.db.taskTags();
    const children = new Map<string, string[]>();
    for (const [id, fields] of raw) {
      const parent = idref(fields, "task");
      if (parent && raw.has(parent)) children.set(parent, [...(children.get(parent) ?? []), id]);
    }
    const rankOf = (id: string) => int(raw.get(id)!, "rank") ?? 0;
    for (const ids of children.values()) ids.sort((a, b) => rankOf(a) - rankOf(b));

    const visit = (id: string, parent: TaskView | null) => {
      const fields = raw.get(id)!;
      const project = typeof fields.project === "object" ? (fields.project as Fields) : null;
      const tagIds = (taskTags.get(id) ?? []).filter((t) => this.tags.has(t));

      let projectStatus: ProjectStatus | null = null;
      if (project) {
        const s = text(project, "status");
        projectStatus = text(fields, "completed") || s === "done" ? "completed"
          : isHidden(fields) || s === "dropped" ? "dropped"
          : s === "inactive" ? "on_hold"
          : "active";
      }
      const folderId = project ? idref(project, "folder") : null;
      const folder = folderId ? this.folders.get(folderId) : undefined;

      const completed = this.date(text(fields, "completed"));
      const dropped = this.date(text(fields, "hidden"));
      let status: TaskStatus =
        completed || projectStatus === "completed" ? "completed"
        : isHidden(fields) || projectStatus === "dropped" || folder?.dropped ? "dropped"
        : "remaining";
      // Inherits completion or dropping from its containers.
      if (status === "remaining" && parent && parent.status !== "remaining") status = parent.status;

      const ownDue = this.date(text(fields, "due"));
      const ownDefer = this.date(text(fields, "start"));
      const due = [ownDue, parent?.due].filter((d) => d).sort((a, b) => +a! - +b!)[0] ?? null;
      const defer = [ownDefer, parent?.defer].filter((d) => d).sort((a, b) => +b! - +a!)[0] ?? null;
      const deferred = !!defer && defer > this.now;

      const sequential = project && bool(project, "singleton") ? false : text(fields, "order") !== "parallel";
      let blocked = !!parent?.blocked
        || projectStatus === "on_hold"
        || tagIds.some((t) => this.tags.get(t)!.status !== "active");
      if (parent?.sequential && !blocked) {
        // Only the first remaining child of a sequential project or group is actionable.
        const first = children.get(parent.id)!.find((c) => {
          const f = raw.get(c)!;
          return !text(f, "completed") && !isHidden(f);
        });
        blocked = first !== id;
      }

      const view: TaskView = {
        id,
        name: text(fields, "name") ?? "",
        note: noteText(fields.note),
        isProject: !!project,
        status,
        projectStatus,
        available: status === "remaining" && !deferred && !blocked,
        blocked,
        deferred,
        inbox: parent ? parent.inbox : !project && bool(fields, "inbox"),
        flagged: bool(fields, "flagged"),
        effectivelyFlagged: bool(fields, "flagged") || !!parent?.effectivelyFlagged,
        parentId: parent?.id ?? null,
        projectId: project ? id : (parent?.projectId ?? null),
        projectName: project ? (text(fields, "name") ?? "") : (parent?.projectName ?? null),
        folderId: project ? (folder?.id ?? null) : (parent?.folderId ?? null),
        folderPath: project ? (folder?.path ?? null) : (parent?.folderPath ?? null),
        tagIds,
        tags: tagIds.map((t) => this.tags.get(t)!.path),
        due,
        defer,
        planned: this.date(text(fields, "planned")),
        completed,
        dropped,
        added: this.date(text(fields, "added")),
        modified: this.date(text(fields, "modified")),
        estimatedMinutes: int(fields, "estimated-minutes"),
        repeat: text(fields, "repetition-rule") ?? text(fields, "repeat"),
        nextReview: project ? this.date(text(project, "next-review")) : null,
        singleActions: !!project && bool(project, "singleton"),
        sequential,
        rank: rankOf(id),
        childIds: children.get(id) ?? [],
      };
      this.tasks.set(id, view);
      for (const child of view.childIds) visit(child, view);
    };

    for (const [id, fields] of raw) {
      const parent = idref(fields, "task");
      if (!parent || !raw.has(parent)) visit(id, null);
    }
  }

  /** Whether the folder is the given one or inside it. */
  folderWithin(folderId: string | null, ancestorId: string): boolean {
    for (let f = folderId, seen = new Set<string>(); f && !seen.has(f); f = this.folders.get(f)?.parentId ?? null) {
      if (f === ancestorId) return true;
      seen.add(f);
    }
    return false;
  }

  /** The task and all of its descendants. */
  descendants(id: string): TaskView[] {
    const task = this.tasks.get(id);
    if (!task) return [];
    return [task, ...task.childIds.flatMap((c) => this.descendants(c))];
  }

  /** The tag and all of its descendants' IDs. */
  tagWithDescendants(id: string): Set<string> {
    const ids = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const tag of this.tags.values())
        if (tag.parentId && ids.has(tag.parentId) && !ids.has(tag.id)) {
          ids.add(tag.id);
          grew = true;
        }
    }
    return ids;
  }
}
