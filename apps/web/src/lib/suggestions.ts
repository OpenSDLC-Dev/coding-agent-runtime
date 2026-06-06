import type { IconName } from "../ui/icons";

export interface Suggestion {
  key: string;
  icon: IconName;
  label: string;
  prompt: string;
}

// Empty-state prompts that kick off a real turn against the runtime.
export const SUGGESTIONS: Suggestion[] = [
  {
    key: "hello",
    icon: "edit",
    label: "Create a file",
    prompt: "Create /workspace/hello.txt with the content hello",
  },
  {
    key: "endpoint",
    icon: "plus",
    label: "Add an API endpoint",
    prompt: "Add a GET /version endpoint that returns the runtime version",
  },
  {
    key: "test",
    icon: "accept",
    label: "Run the test suite",
    prompt: "Run the runtime test suite and report the results",
  },
  {
    key: "explain",
    icon: "information",
    label: "Explain this repo",
    prompt: "Explain what this repository does and how it's structured",
  },
];

// Tool name → Paste icon for tool cards.
export const TOOL_ICON: Record<string, IconName> = {
  Read: "show",
  Write: "edit",
  Edit: "edit",
  Bash: "send",
  Grep: "search",
  Glob: "search",
};
