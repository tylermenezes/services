import { DateTime, DurationLikeObject } from "luxon";
import * as plist from "plist";
import { Database, text } from "./database";
import type { Model, TaskView } from "./model";

// Custom perspectives store their filter rules as a JSON array in their plist's `filterRules`, combined according to
// `topLevelFilterAggregation`. The rule vocabulary is documented for Omni Automation's archivedFilterRules:
// https://omni-automation.com/omnifocus/perspective.html
//
// Built-in perspectives mostly predate rules and only store view settings, so they're defined here.

type Rule = Record<string, unknown>;
type Aggregation = "all" | "any" | "none";

export interface Perspective {
  id: string;
  name: string;
  builtIn: boolean;
  rules: Rule[];
  aggregation: Aggregation;
  /** Lists projects due for review, rather than tasks matching rules. */
  review?: boolean;
  /** Sorts by when tasks were last changed, newest first. */
  byChanged?: boolean;
}

const BUILT_IN: Record<string, Omit<Perspective, "id" | "builtIn" | "aggregation">> = {
  ProcessInbox: { name: "Inbox", rules: [{ actionAvailability: "remaining" }, { actionHasNoProject: true }] },
  ProcessProjects: { name: "Projects", rules: [{ actionAvailability: "remaining" }] },
  ProcessContexts: { name: "Tags", rules: [{ actionAvailability: "remaining" }] },
  ProcessFlagged: { name: "Flagged", rules: [{ actionAvailability: "remaining" }, { actionStatus: "flagged" }] },
  ProcessDueSoon: { name: "Forecast", rules: [{ actionAvailability: "remaining" }, { actionStatus: "due" }] },
  ProcessCompleted: { name: "Completed", rules: [{ actionAvailability: "completed" }] },
  ProcessReview: { name: "Review", rules: [], review: true },
  ProcessRecentChanges: { name: "Changed", rules: [], byChanged: true },
};

function readPlist(value: unknown): Record<string, unknown> {
  // The raw XML, which comes wrapped in an object when the element has attributes (it always has a version).
  const raw = value && typeof value === "object" ? (value as Rule)["#text"] : value;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = plist.parse(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${raw}</plist>`);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Every perspective in the database, built-in ones first. */
export function perspectives(db: Database): Perspective[] {
  const result: Perspective[] = [];
  for (const [id, fields] of db.objects.perspective) {
    const settings = readPlist(fields.plist);
    let rules: Rule[] | null = null;
    if (typeof settings.filterRules === "string") {
      try {
        rules = JSON.parse(settings.filterRules);
      } catch {}
    }
    const aggregation = (settings.topLevelFilterAggregation as Aggregation) ?? "all";
    const builtIn = BUILT_IN[id];
    if (builtIn) result.push({ id, aggregation, ...builtIn, builtIn: true, rules: rules ?? builtIn.rules });
    else if (rules) result.push({ id, name: String(settings.name ?? text(fields, "name") ?? id), builtIn: false, rules, aggregation });
  }
  // Built-in perspectives are only stored once they've been customized.
  for (const [id, builtIn] of Object.entries(BUILT_IN))
    if (!result.some((p) => p.id === id)) result.push({ id, aggregation: "all", ...builtIn, builtIn: true });
  return result.sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name));
}

const DATE_FIELDS: Record<string, (t: TaskView) => DateTime | null> = {
  due: (t) => t.due,
  defer: (t) => t.defer,
  planned: (t) => t.planned,
  completed: (t) => t.completed,
  dropped: (t) => t.dropped,
  added: (t) => t.added,
  changed: (t) => t.modified,
};
const UNITS: Record<string, keyof DurationLikeObject> = { year: "years", month: "months", week: "weeks", day: "days", hour: "hours" };

/** A date in a rule: ISO 8601, or today/tomorrow/yesterday/now, or a relative amount like "+3d" or "2 weeks ago". */
function dateSpec(value: unknown, model: Model): DateTime {
  const spec = typeof value === "object" && value ? (value as Rule).dynamic ?? (value as Rule).date : value;
  const input = String(spec ?? "").trim().toLowerCase();
  const today = model.now.startOf("day");
  const named: Record<string, DateTime> = { now: model.now, today, tomorrow: today.plus({ days: 1 }), yesterday: today.minus({ days: 1 }) };
  if (named[input]) return named[input];
  const relative = input.match(/^([+-]?\d+)\s*(h|hours?|d|days?|w|weeks?|m|months?|y|years?)(\s+ago)?$/);
  if (relative) {
    const unit = { h: "hours", d: "days", w: "weeks", m: "months", y: "years" }[relative[2][0]]!;
    const amount = Number(relative[1]) * (relative[3] ? -1 : 1);
    return (unit === "hours" ? model.now : today).plus({ [unit]: amount });
  }
  const iso = DateTime.fromISO(String(spec ?? ""), { zone: model.zone });
  if (iso.isValid) return iso;
  throw new Error(`Can't read the date "${spec}" in this perspective's rules.`);
}

/** A rule's date window as a test on a date. */
function dateTest(rule: Rule, model: Model): (d: DateTime) => boolean {
  const today = model.now.startOf("day");
  const sameDay = (day: DateTime) => (d: DateTime) => d.setZone(model.zone).hasSame(day, "day");
  const relative = (v: Rule, sign: 1 | -1) => {
    const amount = Number(v.relativeAfterAmount ?? v.relativeBeforeAmount ?? v.relativeAmount);
    const unit = UNITS[String(v.relativeComponent)];
    if (!unit || Number.isNaN(amount)) throw new Error(`Can't read the relative date ${JSON.stringify(v)} in this perspective's rules.`);
    return model.now.plus({ [unit]: sign * amount });
  };
  if (rule.actionDateIsToday) return sameDay(today);
  if (rule.actionDateIsTomorrow) return sameDay(today.plus({ days: 1 }));
  if (rule.actionDateIsYesterday) return sameDay(today.minus({ days: 1 }));
  if (rule.actionDateIsInTheNext) {
    const end = relative(rule.actionDateIsInTheNext as Rule, 1);
    return (d) => d >= model.now && d <= end;
  }
  if (rule.actionDateIsInThePast) {
    const start = relative(rule.actionDateIsInThePast as Rule, -1);
    return (d) => d >= start && d <= model.now;
  }
  if (rule.actionDateIsOnDateSpec) return sameDay(dateSpec(rule.actionDateIsOnDateSpec, model));
  if (rule.actionDateIsAfterDateSpec || rule.actionDateIsBeforeDateSpec) {
    const after = rule.actionDateIsAfterDateSpec ? dateSpec(rule.actionDateIsAfterDateSpec, model) : null;
    const before = rule.actionDateIsBeforeDateSpec ? dateSpec(rule.actionDateIsBeforeDateSpec, model) : null;
    return (d) => (!after || d >= after) && (!before || d <= before);
  }
  // A date field on its own means the item has that date.
  return () => true;
}

const combine = (aggregation: Aggregation, tests: ((t: TaskView) => boolean)[]) => {
  if (aggregation === "any") return (t: TaskView) => tests.some((f) => f(t));
  if (aggregation === "none") return (t: TaskView) => !tests.some((f) => f(t));
  return (t: TaskView) => tests.every((f) => f(t));
};

/**
 * A filter matching the items a perspective shows. Throws if it uses a rule this can't evaluate, rather than giving a
 * list that doesn't match OmniFocus's.
 */
export function perspectiveFilter(model: Model, perspective: Perspective): { matches: (t: TaskView) => boolean; includesProjects: boolean } {
  if (perspective.review) {
    return { matches: (t) => t.isProject && t.status === "remaining" && !!t.nextReview && t.nextReview <= model.now, includesProjects: true };
  }
  const all = [...model.tasks.values()];
  const remaining = (t: TaskView) => t.status === "remaining";
  const containing = (t: TaskView) => (t.projectId ? model.tasks.get(t.projectId) : undefined);
  const contents = (project: TaskView) => model.descendants(project.id).slice(1);
  const stalled = (tasks: TaskView[]) => tasks.some(remaining) && !tasks.some((t) => t.available);

  // The first available action in each project, in outline order. Each inbox item stands alone.
  const firstAvailable = new Set<string>();
  for (const t of all) {
    if (!t.isProject) continue;
    const first = contents(t).find((c) => c.available && !c.childIds.some((id) => remaining(model.tasks.get(id)!)));
    if (first) firstAvailable.add(first.id);
  }

  let includesProjects = false;
  const compile = (rule: Rule): ((t: TaskView) => boolean) => {
    if ("aggregateType" in rule) {
      const rules = rule.aggregateRules ?? rule.rules;
      if (!Array.isArray(rules)) throw new Error(`This perspective has a group of rules in a format that isn't supported: ${JSON.stringify(rule)}`);
      return combine(rule.aggregateType as Aggregation, rules.map(compile));
    }
    if ("actionDateField" in rule) {
      const field = DATE_FIELDS[String(rule.actionDateField)];
      if (!field) throw new Error(`This perspective filters on the date "${rule.actionDateField}", which isn't supported.`);
      const test = dateTest(rule, model);
      return (t) => {
        const d = field(t);
        return !!d && test(d);
      };
    }
    const keys = Object.keys(rule);
    if (keys.length !== 1) throw new Error(`This perspective has a rule that isn't supported: ${JSON.stringify(rule)}`);
    const [key] = keys;
    const value = rule[key];
    const ids = Array.isArray(value) ? value.map(String) : [];
    switch (key) {
      case "actionAvailability":
        switch (value) {
          case "available": return (t) => t.available;
          case "firstAvailable": return (t) => t.available && (firstAvailable.has(t.id) || (t.inbox && !t.childIds.length));
          case "remaining": return remaining;
          case "completed": return (t) => t.status === "completed";
          case "dropped": return (t) => t.status === "dropped";
        }
        break;
      case "actionStatus":
        if (value === "due") return (t) => remaining(t) && !!t.due && t.due <= model.dueSoon;
        if (value === "flagged") return (t) => t.effectivelyFlagged;
        break;
      case "actionHasDueDate": return (t) => !!t.due === !!value;
      case "actionHasDeferDate": return (t) => !!t.defer === !!value;
      case "actionHasDuration": return (t) => (t.estimatedMinutes !== null) === !!value;
      case "actionWithinDuration": return (t) => t.estimatedMinutes !== null && t.estimatedMinutes <= Number(value);
      case "actionIsProject":
        includesProjects = true;
        return (t) => t.isProject === !!value;
      case "actionIsProjectOrGroup":
        includesProjects = true;
        return (t) => (t.isProject || t.childIds.length > 0) === !!value;
      case "actionIsGroup": return (t) => (!t.isProject && t.childIds.length > 0) === !!value;
      case "actionIsLeaf": return (t) => (!t.isProject && t.childIds.length === 0) === !!value;
      case "actionRepeats": return (t) => !!t.repeat === !!value;
      case "actionIsUntagged": return (t) => (t.tagIds.length === 0) === !!value;
      case "actionHasNoProject": return (t) => !t.projectId === !!value;
      case "actionIsInSingleActionsList": return (t) => !!containing(t)?.singleActions === !!value;
      case "actionHasAnyOfTags":
      case "actionHasAllOfTags": {
        // A tag includes its child tags, as tag perspectives do.
        const sets = ids.map((id) => model.tagWithDescendants(id));
        return key === "actionHasAnyOfTags"
          ? (t) => sets.some((s) => t.tagIds.some((id) => s.has(id)))
          : (t) => sets.every((s) => t.tagIds.some((id) => s.has(id)));
      }
      case "actionHasTagWithStatus": {
        const tagTasks = (tagId: string) => all.filter((t) => !t.isProject && t.tagIds.includes(tagId));
        const statusTest: Record<string, (tagId: string) => boolean> = {
          active: (id) => model.tags.get(id)!.status === "active",
          remaining: (id) => model.tags.get(id)!.status !== "dropped",
          onHold: (id) => model.tags.get(id)!.status === "on_hold",
          dropped: (id) => model.tags.get(id)!.status === "dropped",
          stalled: (id) => model.tags.get(id)!.status === "active" && stalled(tagTasks(id)),
        };
        const test = statusTest[String(value)];
        if (test) return (t) => t.tagIds.some(test);
        break;
      }
      case "actionHasProjectWithStatus": {
        const statusTest: Record<string, (p: TaskView) => boolean> = {
          active: (p) => p.projectStatus === "active",
          remaining: (p) => p.projectStatus === "active" || p.projectStatus === "on_hold",
          onHold: (p) => p.projectStatus === "on_hold",
          completed: (p) => p.projectStatus === "completed",
          dropped: (p) => p.projectStatus === "dropped",
          stalled: (p) => p.projectStatus === "active" && !p.deferred && stalled(contents(p)),
          pending: (p) => p.projectStatus === "active" && p.deferred,
        };
        const test = statusTest[String(value)];
        if (test)
          return (t) => {
            const p = containing(t);
            return !!p && test(p);
          };
        break;
      }
      case "actionWithinFocus":
        return (t) =>
          ids.some((id) => {
            if (model.folders.has(id)) return model.folderWithin(t.folderId, id);
            for (let a: TaskView | undefined = t; a; a = a.parentId ? model.tasks.get(a.parentId) : undefined)
              if (a.id === id) return true;
            return false;
          });
      case "actionMatchingSearch": {
        const phrases = (Array.isArray(value) ? value : [value]).map((p) => String(p).toLowerCase());
        return (t) => phrases.every((p) => `${t.name}\n${t.note ?? ""}`.toLowerCase().includes(p));
      }
    }
    throw new Error(`This perspective has a rule that isn't supported: ${JSON.stringify(rule)}`);
  };

  const matches = combine(perspective.aggregation, perspective.rules.map(compile));
  return { matches, includesProjects };
}

/** Finds a perspective by ID or (case-insensitive) name. */
export function findPerspective(all: Perspective[], input: string): Perspective {
  const byId = all.find((p) => p.id === input);
  if (byId) return byId;
  const matches = all.filter((p) => p.name.toLowerCase() === input.trim().toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`"${input}" matches ${matches.length} perspectives; use an ID: ${matches.map((p) => p.id).join(", ")}`);
  throw new Error(`No OmniFocus perspective named "${input}". Available: ${all.map((p) => p.name).join(", ")}`);
}

/** A readable description of a perspective's rules, with IDs replaced by names. */
export function describePerspective(model: Model, perspective: Perspective): string {
  if (perspective.review) return "projects due for review";
  if (perspective.byChanged) return "everything, most recently changed first";
  const name = (id: string) =>
    model.folders.get(id)?.path ?? model.tasks.get(id)?.name ?? model.tags.get(id)?.path ?? `(missing ${id})`;
  const describe = (rule: Rule): string => {
    if ("aggregateType" in rule)
      return `${rule.aggregateType} of (${((rule.aggregateRules ?? rule.rules) as Rule[] | undefined)?.map(describe).join("; ")})`;
    if ("actionDateField" in rule) {
      const window = Object.entries(rule).filter(([k]) => k !== "actionDateField").map(([k, v]) =>
        `${k.replace(/^actionDateIs/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase()}${v === true ? "" : ` ${JSON.stringify(v)}`}`);
      return `${rule.actionDateField} date${window.length ? ` ${window.join(", ")}` : " is set"}`;
    }
    const [[key, value]] = Object.entries(rule);
    const names = Array.isArray(value) ? value.map((id) => name(String(id))).join(", ") : "";
    switch (key) {
      case "actionAvailability": return `${value === "firstAvailable" ? "first available" : value}`;
      case "actionStatus": return value === "due" ? "due soon or overdue" : String(value);
      case "actionHasAnyOfTags": return `tagged with any of: ${names}`;
      case "actionHasAllOfTags": return `tagged with all of: ${names}`;
      case "actionWithinFocus": return `within: ${names}`;
      case "actionMatchingSearch": return `matching: ${(value as string[]).join(", ")}`;
      default: {
        const words = key.replace(/^action/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase();
        return value === true ? words : value === false ? `not ${words}` : `${words}: ${value}`;
      }
    }
  };
  const parts = perspective.rules.map(describe);
  if (!parts.length) return "everything";
  return perspective.aggregation === "all" ? parts.join("; ") : `${perspective.aggregation} of: ${parts.join("; ")}`;
}
