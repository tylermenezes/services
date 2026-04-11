import { obsidian, NoteEntry } from "@/clients";
import { markdownFrontmatter, markdownParse } from "@/utils";
import { DateTime } from "luxon";
import { Heading, Text } from "mdast";
import debug from "debug";

const DEBUG = debug("services:datasources:rfc");

interface NoteEnhance {
  title: string;
  tags: string[];
  image?: string;
  slug: string;
  publish: boolean;
  unlisted: boolean;
}

export async function getRfcs(): Promise<NoteEnhance[]> {
  const rfcNoteNames = obsidian.noteFilterByFrontmatter(
    (fm) => fm?.publish === true,
  );
  return (await obsidian.noteReadMulti(rfcNoteNames))
    .filter(Boolean)
    .map((n) => {
      const fm = markdownFrontmatter<{
        image?: string;
        publish?: boolean;
        unlisted?: boolean;
        date?: string;
        slug?: string;
      }>(n.data);
      const md = markdownParse(n.data);
      const h1 = md.find(
        (n) => n.type === "heading" && (n as Heading).depth === 1,
      ) as Heading | undefined;
      if (!h1) return null;
      return {
        title: h1.children.map((c) => (c as Text).value).join(" "),
        path: n.path,
        slug:
          fm.slug ||
          n.path
            .replace("rfc/", "")
            .replace(".md", "")
            .replace(/[^a-z0-9\-]/g, "-")
            .replace(/--+/g, "-"),
        data: n.data,
        image: fm.image,
        publish: fm.publish || false,
        unlisted: fm.unlisted || false,
        createdAt:
          (fm.date ? DateTime.fromISO(fm.date).toJSDate() : n.createdAt) ||
          n.createdAt,
        updatedAt: n.updatedAt,
        tags: (
          [
            ...n.data
              .split(`\n`)
              .slice(0, Object.keys(fm).length + 4)
              .join(`\n`)
              .matchAll(/#[a-zA-Z-\_]+/g),
          ] as string[][]
        )
          .flatMap((e) => e[0].slice(1))
          .filter((t) => t !== "rfc"),
      };
    })
    .filter(Boolean) as NoteEnhance[];
}
