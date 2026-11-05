"use client";

import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconCopy, IconCheck, IconCode } from "@tabler/icons-react";
import { toast } from "sonner";
import dynamic from "next/dynamic";
import { useTheme } from "@/components/providers";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
      Loading snippet…
    </div>
  ),
});

interface CodeSnippetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  env: string;
  twxBaseUrl?: string;
  entityType: string;
  entityName: string;
  serviceName: string;
  inputs: Record<string, unknown>;
}

export function CodeSnippetDialog({
  open,
  onOpenChange,
  env,
  twxBaseUrl = "https://your-twx-server.com",
  entityType,
  entityName,
  serviceName,
  inputs,
}: CodeSnippetDialogProps) {
  const [activeTab, setActiveTab] = useState<"curl" | "fetch" | "twx-js" | "cli">("curl");
  const [copied, setCopied] = useState(false);
  const { resolvedTheme } = useTheme();

  const baseUrl = twxBaseUrl?.replace(/\/+$/, "") || "https://your-twx-server.com";
  const jsonPayload = useMemo(() => JSON.stringify(inputs, null, 2), [inputs]);
  const minifiedPayload = useMemo(() => JSON.stringify(inputs), [inputs]);

  const snippets = useMemo(() => {
    const url = `${baseUrl}/Thingworx/${entityType}/${encodeURIComponent(entityName)}/Services/${encodeURIComponent(serviceName)}`;

    const curl = `curl -X POST "${url}" \\
  -H "Accept: application/json" \\
  -H "Content-Type: application/json" \\
  -H "appKey: YOUR_APP_KEY" \\
  -d '${minifiedPayload}'`;

    const fetchSnippet = `async function call${serviceName.replace(/[^a-zA-Z0-9]/g, "")}() {
  const url = "${url}";
  const payload = ${jsonPayload};

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "appKey": process.env.TWX_APP_KEY || "YOUR_APP_KEY",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(\`TWX Error (\${response.status}): \${errorText}\`);
  }

  const data = await response.json();
  return data;
}

// Execute
call${serviceName.replace(/[^a-zA-Z0-9]/g, "")}()
  .then(data => console.log("Result:", data))
  .catch(err => console.error("Failed:", err));`;

    const twxJs = `// ThingWorx Server-Side JavaScript Service
let params = ${jsonPayload};

let result = ${entityType}["${entityName}"].${serviceName}(params);`;

    const cli = `singl twx:service --env "${env}" --type "${entityType}" --name "${entityName}" --service "${serviceName}" --params '${minifiedPayload}'`;

    return {
      curl: { code: curl, lang: "shell" },
      fetch: { code: fetchSnippet, lang: "typescript" },
      "twx-js": { code: twxJs, lang: "javascript" },
      cli: { code: cli, lang: "shell" },
    };
  }, [baseUrl, entityType, entityName, serviceName, jsonPayload, minifiedPayload, env]);

  const currentSnippet = snippets[activeTab];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentSnippet.code);
      setCopied(true);
      toast.success("Snippet copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy snippet");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl h-[540px] flex flex-col gap-3 p-5">
        <DialogHeader className="shrink-0">
          <div className="flex items-center justify-between gap-2 mr-6">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <IconCode className="size-5 text-primary" />
              Code Snippets
              <Badge variant="outline" className="text-[11px] font-mono font-normal">
                {entityName} / {serviceName}
              </Badge>
            </DialogTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCopy}
              className="h-8 gap-1.5 text-xs font-medium"
            >
              {copied ? (
                <>
                  <IconCheck className="size-3.5 text-emerald-500" />
                  Copied
                </>
              ) : (
                <>
                  <IconCopy className="size-3.5" />
                  Copy Code
                </>
              )}
            </Button>
          </div>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as typeof activeTab)}
          className="flex flex-col flex-1 min-h-0 overflow-hidden"
        >
          <TabsList className="grid grid-cols-4 h-9 p-1 shrink-0 bg-muted/60">
            <TabsTrigger value="curl" className="text-xs">cURL</TabsTrigger>
            <TabsTrigger value="fetch" className="text-xs">TypeScript Fetch</TabsTrigger>
            <TabsTrigger value="twx-js" className="text-xs">TWX Script</TabsTrigger>
            <TabsTrigger value="cli" className="text-xs">Singl CLI</TabsTrigger>
          </TabsList>

          <div className="flex-1 min-h-0 mt-3 border rounded-lg overflow-hidden bg-background">
            <TabsContent value="curl" className="h-full m-0 p-0">
              <MonacoEditor
                height="100%"
                language="shell"
                value={snippets.curl.code}
                theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  lineNumbers: "off",
                }}
              />
            </TabsContent>
            <TabsContent value="fetch" className="h-full m-0 p-0">
              <MonacoEditor
                height="100%"
                language="typescript"
                value={snippets.fetch.code}
                theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  lineNumbers: "on",
                }}
              />
            </TabsContent>
            <TabsContent value="twx-js" className="h-full m-0 p-0">
              <MonacoEditor
                height="100%"
                language="javascript"
                value={snippets["twx-js"].code}
                theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  lineNumbers: "on",
                }}
              />
            </TabsContent>
            <TabsContent value="cli" className="h-full m-0 p-0">
              <MonacoEditor
                height="100%"
                language="shell"
                value={snippets.cli.code}
                theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  lineNumbers: "off",
                }}
              />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

