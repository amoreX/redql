import OpenAI from "openai";

// Basic tool set (mirrors furnace's primitives). These are just DEFINITIONS the
// model sees — execution happens on the DEVICE, never here. Keep args minimal.
export const TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file's contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Create or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ls",
      description: "List directory contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory (defaults to cwd)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search files for a text pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text/regex to search for" },
          path: { type: "string", description: "File or dir (defaults to cwd)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command when the other tools aren't enough.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
        },
        required: ["command"],
      },
    },
  },
];
