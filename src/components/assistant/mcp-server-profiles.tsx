"use client";

// Settings → AI: per-client tool profiles for the app's own MCP server. A
// profile names an outside client (its MCP `clientInfo.name`, or "*" for any
// other), the tool groups it may use and the riskiest tool it may call.
// No profiles means every client sees everything.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { errorMessage } from "@/lib/settings";

type Risk = "read" | "write" | "destructive";

export type McpProfile = {
  client: string;
  groups: string[];
  maxRisk: Risk;
};

type ProfilesView = { profiles: McpProfile[]; groups: string[] };

const RISKS: { id: Risk; label: string }[] = [
  { id: "read", label: "Read only" },
  { id: "write", label: "Up to write" },
  { id: "destructive", label: "Everything (destructive too)" },
];

const riskLabel = (r: Risk) => RISKS.find((x) => x.id === r)?.label ?? r;

export function McpServerProfiles() {
  const [profiles, setProfiles] = useState<McpProfile[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  // `index` -1 is a new profile.
  const [editing, setEditing] = useState<{
    index: number;
    draft: McpProfile;
  } | null>(null);

  useEffect(() => {
    invoke<ProfilesView>("assistant_mcp_profiles_get")
      .then((v) => {
        setProfiles(v.profiles);
        setGroups(v.groups);
      })
      .catch((e) => toast.error(errorMessage(e)));
  }, []);

  const persist = useCallback(async (next: McpProfile[]) => {
    try {
      setProfiles(
        await invoke<McpProfile[]>("assistant_mcp_profiles_set", {
          profiles: next,
        }),
      );
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  }, []);

  const draft = editing?.draft;
  const setDraft = (patch: Partial<McpProfile>) =>
    setEditing((cur) => cur && { ...cur, draft: { ...cur.draft, ...patch } });

  const save = async () => {
    if (!editing) return;
    const client = editing.draft.client.trim();
    if (!client) {
      toast.error("Enter the client name, or * for every other client.");
      return;
    }
    const next = [...profiles];
    const item = { ...editing.draft, client };
    if (editing.index < 0) next.push(item);
    else next[editing.index] = item;
    if (await persist(next)) setEditing(null);
  };

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <CardTitle className="text-xs font-semibold">
            Client tool profiles
          </CardTitle>
          <Button
            className="ml-auto"
            size="sm"
            variant="outline"
            onClick={() =>
              setEditing({
                index: -1,
                draft: { client: "", groups: [...groups], maxRisk: "write" },
              })
            }
          >
            <IconPlus /> Add profile
          </Button>
        </div>
        <CardDescription className="text-[11px]">
          Limit which tools an outside MCP client sees, by the name it reports
          (claude-code, codex, copilot…). Use * for clients with no profile of
          their own. With no profiles, every client gets every tool.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-3.5">
        {profiles.length === 0 && !editing && (
          <p className="text-xs text-muted-foreground">
            No profiles: all clients get all tools.
          </p>
        )}
        {profiles.map((p, i) => (
          <div
            key={p.client}
            className="flex items-center gap-2 rounded-md border px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div className="font-mono text-xs">{p.client}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {riskLabel(p.maxRisk)} ·{" "}
                {p.groups.length === 0 ? "no tools" : p.groups.join(", ")}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Edit ${p.client}`}
              onClick={() =>
                setEditing({
                  index: i,
                  draft: { ...p, groups: [...p.groups] },
                })
              }
            >
              <IconPencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Delete ${p.client}`}
              onClick={() => {
                if (editing?.index === i) setEditing(null);
                void persist(profiles.filter((_, j) => j !== i));
              }}
            >
              <IconTrash />
            </Button>
          </div>
        ))}

        {editing && draft && (
          <div className="space-y-3 rounded-md border bg-muted/30 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="mcp-profile-client" className="text-xs">
                  Client name
                </Label>
                <Input
                  id="mcp-profile-client"
                  value={draft.client}
                  placeholder="claude-code, or * for the default"
                  onChange={(e) => setDraft({ client: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mcp-profile-risk" className="text-xs">
                  Riskiest tool allowed
                </Label>
                <NativeSelect
                  id="mcp-profile-risk"
                  className="w-full"
                  value={draft.maxRisk}
                  onChange={(e) => setDraft({ maxRisk: e.target.value as Risk })}
                >
                  {RISKS.map((r) => (
                    <NativeSelectOption key={r.id} value={r.id}>
                      {r.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Tool groups</Label>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {groups.map((g) => (
                  <label
                    key={g}
                    className="flex items-center gap-1.5 text-xs"
                    htmlFor={`mcp-group-${g}`}
                  >
                    <Checkbox
                      id={`mcp-group-${g}`}
                      checked={draft.groups.includes(g)}
                      onCheckedChange={(on) =>
                        setDraft({
                          groups: on
                            ? [...draft.groups, g]
                            : draft.groups.filter((x) => x !== g),
                        })
                      }
                    />
                    {g}
                  </label>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                &ldquo;mcp&rdquo; is tools from other MCP servers; &ldquo;other&rdquo;
                is anything not in a named group.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={() => void save()}>
                Save profile
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
