"use client";

import { useState } from "react";
import Link from "next/link";
import {
  IconGitBranch,
  IconAlertCircle,
  IconCheck,
  IconBrandGithub,
  IconBrandGitlab,
  IconBrandAzure,
  IconArrowRight,
  IconFolderCode,
  IconShieldCheck,
  IconShieldX,
  IconSearch,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface RepoSetupCardProps {
  hasPatToken: boolean;
  repoUrl: string;
  onRepoUrlChange: (url: string) => void;
  branches: string[];
  selectedBranch: string;
  onSelectBranch: (branch: string) => void;
  fetchingBranches: boolean;
  branchError: string | null;
  onFetchBranches: () => void;
  cloneStatus: "idle" | "cloning" | "done" | "error";
  onClone: () => void;
}

function getProviderInfo(url: string) {
  const lower = url.toLowerCase();
  if (lower.includes("github.com")) {
    return { name: "GitHub", icon: IconBrandGithub, color: "text-foreground" };
  }
  if (lower.includes("dev.azure.com") || lower.includes("visualstudio.com")) {
    return { name: "Azure DevOps", icon: IconBrandAzure, color: "text-blue-500" };
  }
  if (lower.includes("gitlab.com")) {
    return { name: "GitLab", icon: IconBrandGitlab, color: "text-orange-500" };
  }
  return { name: "Git Repository", icon: IconFolderCode, color: "text-primary" };
}

export function RepoSetupCard({
  hasPatToken,
  repoUrl,
  onRepoUrlChange,
  branches,
  selectedBranch,
  onSelectBranch,
  fetchingBranches,
  branchError,
  onFetchBranches,
  cloneStatus,
  onClone,
}: RepoSetupCardProps) {
  const [branchFilter, setBranchFilter] = useState("");
  const provider = getProviderInfo(repoUrl);
  const ProviderIcon = provider.icon;

  const canFetch = repoUrl.trim().length > 0 && !fetchingBranches;
  const canClone = !!selectedBranch && cloneStatus !== "cloning";

  const filteredBranches = branches.filter((b) =>
    b.toLowerCase().includes(branchFilter.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 bg-muted/10 overflow-y-auto">
      <div className="w-full max-w-2xl space-y-6">
        {/* Welcome Hero / Card */}
        <Card className="border shadow-sm bg-card">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="size-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center border border-primary/20 shadow-xs">
                  <IconGitBranch className="size-5" />
                </div>
                <div>
                  <CardTitle className="text-base font-semibold">
                    Clone & Explore Repository
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Connect a Git repository to browse code, inspect commits, view diffs, and extract packages.
                  </CardDescription>
                </div>
              </div>

              {/* PAT Status Badge */}
              <div>
                {hasPatToken ? (
                  <Badge
                    variant="outline"
                    className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 text-[11px] gap-1 px-2.5 py-1"
                  >
                    <IconShieldCheck className="size-3.5" />
                    PAT Configured
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 text-[11px] gap-1 px-2.5 py-1"
                  >
                    <IconShieldX className="size-3.5" />
                    No PAT
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-5 pt-2">
            {!hasPatToken && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2.5">
                <IconAlertCircle className="size-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Authentication recommended for private repositories</p>
                  <p className="mt-0.5 text-muted-foreground text-[11px]">
                    If your repository is private or hosted on Azure DevOps, please add your PAT in{" "}
                    <Link href="/settings" className="underline font-semibold hover:text-foreground">
                      Settings
                    </Link>.
                  </p>
                </div>
              </div>
            )}

            {/* Step 1: URL Input */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium flex items-center gap-1.5">
                  <span className="flex size-4 items-center justify-center rounded-full bg-primary/20 text-primary text-[10px] font-bold">
                    1
                  </span>
                  Repository URL
                </Label>
                {repoUrl && (
                  <Badge variant="secondary" className="text-[10px] gap-1 font-normal py-0 h-4">
                    <ProviderIcon className={cn("size-2.5", provider.color)} />
                    {provider.name}
                  </Badge>
                )}
              </div>

              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    placeholder="https://dev.azure.com/org/project/_git/repo or https://github.com/user/repo"
                    value={repoUrl}
                    onChange={(e) => onRepoUrlChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canFetch) onFetchBranches();
                    }}
                    className="h-9 text-xs font-mono pr-8"
                  />
                  {repoUrl && (
                    <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                      <ProviderIcon className={cn("size-4 opacity-50", provider.color)} />
                    </div>
                  )}
                </div>

                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onFetchBranches}
                  disabled={!canFetch}
                  className="h-9 text-xs px-3.5 whitespace-nowrap gap-1.5 shadow-xs"
                >
                  {fetchingBranches ? (
                    <>
                      <Spinner className="size-3.5" />
                      Fetching…
                    </>
                  ) : (
                    <>
                      Fetch Branches
                      <IconArrowRight className="size-3.5" />
                    </>
                  )}
                </Button>
              </div>

              {branchError && (
                <p className="text-xs text-destructive flex items-center gap-1 mt-1">
                  <IconAlertCircle className="size-3.5 shrink-0" />
                  {branchError}
                </p>
              )}
            </div>

            {/* Step 2: Branch Selection */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium flex items-center gap-1.5">
                  <span className="flex size-4 items-center justify-center rounded-full bg-primary/20 text-primary text-[10px] font-bold">
                    2
                  </span>
                  Branch to Clone
                </Label>
                {branches.length > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    {branches.length} branches available
                  </span>
                )}
              </div>

              {branches.length > 0 ? (
                <div className="space-y-2">
                  <Select value={selectedBranch} onValueChange={(v) => onSelectBranch(v ?? "")}>
                    <SelectTrigger className="h-9 text-xs font-mono">
                      <div className="flex items-center gap-2 truncate">
                        <IconGitBranch className="size-3.5 text-muted-foreground shrink-0" />
                        <SelectValue placeholder="Select a branch" />
                      </div>
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {branches.length > 6 && (
                        <div className="px-2 pb-1.5 pt-1 border-b sticky top-0 bg-popover z-10">
                          <div className="relative">
                            <IconSearch className="size-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                            <Input
                              value={branchFilter}
                              onChange={(e) => setBranchFilter(e.target.value)}
                              placeholder="Filter branches..."
                              className="h-7 text-xs pl-7"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                        </div>
                      )}
                      {filteredBranches.map((b) => (
                        <SelectItem key={b} value={b} className="text-xs font-mono">
                          <div className="flex items-center gap-2">
                            <span>{b}</span>
                            {(b === "main" || b === "master") && (
                              <Badge variant="secondary" className="text-[9px] px-1 py-0 h-3.5">
                                default
                              </Badge>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                      {filteredBranches.length === 0 && (
                        <p className="text-xs text-muted-foreground p-2 text-center">
                          No matching branches
                        </p>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <Input
                  value={selectedBranch}
                  onChange={(e) => onSelectBranch(e.target.value)}
                  placeholder="Fetch branches above or type branch name (e.g. main)"
                  className="h-9 text-xs font-mono"
                />
              )}
            </div>

            {/* Action Bar */}
            <div className="pt-2 flex items-center justify-end gap-3 border-t">
              <Button
                size="default"
                onClick={onClone}
                disabled={!canClone}
                className="h-9 px-5 text-xs font-medium gap-2 shadow-xs"
              >
                {cloneStatus === "cloning" ? (
                  <>
                    <Spinner className="size-3.5" />
                    Cloning Repository…
                  </>
                ) : (
                  <>
                    <IconCheck className="size-3.5" />
                    Clone Repository
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Quick Tips */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-muted-foreground">
          <div className="p-3 rounded-lg border bg-card/60 space-y-1">
            <p className="font-medium text-foreground">💡 Fast Branch Switching</p>
            <p className="text-[11px] leading-relaxed">
              Once cloned, switch branches directly from the top toolbar without re-cloning.
            </p>
          </div>
          <div className="p-3 rounded-lg border bg-card/60 space-y-1">
            <p className="font-medium text-foreground">📦 TWX Package Extraction</p>
            <p className="text-[11px] leading-relaxed">
              Extract XML entity packages with a single click to inspect services and mashups locally.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
