import Link from "next/link";
import {
  IconGitBranch,
  IconGitCompare,
  IconBoxMultiple,
  IconSettings,
  IconArrowRight,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";

const features = [
  {
    title: "Repository",
    description:
      "Clone and browse Git repositories. Switch branches and explore your codebase with a built-in editor.",
    href: "/repo",
    icon: IconGitBranch,
  },
  {
    title: "TWX Entities",
    description:
      "Browse and export ThingWorx entities across projects and environments.",
    href: "/twx-entities",
    icon: IconBoxMultiple,
  },
  {
    title: "Compare",
    description:
      "Diff TWX entity definitions against your repository to review and track changes.",
    href: "/compare",
    icon: IconGitCompare,
  },
  {
    title: "Settings",
    description:
      "Configure ThingWorx server connections, Azure DevOps tokens, and local path mappings.",
    href: "/settings",
    icon: IconSettings,
  },
];

export default function Home() {
  return (
    <div className="flex flex-col flex-1 overflow-y-auto">
      <section
        className="flex flex-col items-center justify-center gap-5 px-8 py-16 text-center border-b"
        style={{
          background:
            "linear-gradient(to bottom, color-mix(in oklch, var(--primary) 8%, transparent), transparent)",
        }}
      >
        <div
          className="flex size-12 items-center justify-center rounded-xl shadow-md"
          style={{
            background:
              "linear-gradient(135deg, var(--primary) 0%, oklch(0.5 0.22 260) 100%)",
          }}
        >
          <span className="text-xl font-bold text-white tracking-tight">S</span>
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            Singl Workspace
          </h1>
          <p className="max-w-sm text-sm text-muted-foreground leading-relaxed">
            Sync ThingWorx entities with Git. Manage environments, explore
            definitions, and track changes across versions.
          </p>
        </div>

        <Button
          render={<Link href="/twx-entities" />}
          nativeButton={false}
          size="lg"
          className="gap-2 rounded-full px-6"
        >
          Get started <IconArrowRight size={14} />
        </Button>
      </section>

      <section className="p-8 w-full max-w-2xl mx-auto">
        <div className="grid grid-cols-2 gap-3">
          {features.map((feature) => (
            <Link key={feature.href} href={feature.href}>
              <div className="group flex flex-col gap-3 rounded-xl border bg-card p-5 h-full transition-all hover:shadow-sm hover:border-primary/40">
                <div
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: "color-mix(in oklch, var(--primary) 12%, transparent)",
                    color: "var(--primary)",
                  }}
                >
                  <feature.icon size={17} />
                </div>
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold leading-none">
                    {feature.title}
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
