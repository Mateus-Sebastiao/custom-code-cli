import React, { useState, useEffect } from 'react';
import { render, Box, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as exec from 'child_process';
import * as dotenv from 'dotenv';

dotenv.config();

// ==========================================
// 1. TYPES & INTERFACES
// ==========================================
type ToolExecutor = (args: any) => Promise<string> | string;

interface AgentToolDefinition {
  openaiDefinition: OpenAI.Chat.Completions.ChatCompletionTool;
  execute: ToolExecutor;
}

// ==========================================
// 2. AGENT TOOLS DEFINITION
// ==========================================
const AGENT_TOOLS: Record<string, AgentToolDefinition> = {
  listDirectory: {
    openaiDefinition: {
      type: 'function',
      function: {
        name: 'listDirectory',
        description: 'List all files and folders in the current working directory to know the path location and structure.',
        parameters: { type: 'object', properties: {} }
      }
    },
    execute: (): string => {
      try {
        const files = fs.readdirSync(process.cwd());
        return `Current Location: ${process.cwd()}\nFiles in directory:\n${files.join('\n')}`;
      } catch (error) {
        return `Error listing directory: ${(error as Error).message}`;
      }
    }
  },
  readFile: {
    openaiDefinition: {
      type: 'function',
      function: {
        name: 'readFile',
        description: 'Read the text content of a specific local file. Do NOT use this on directories.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The relative or absolute path to a specific file.' }
          },
          required: ['path']
        }
      }
    },
    execute: (args: { path: string }): string => {
      try {
        return fs.readFileSync(args.path, 'utf8');
      } catch (error) {
        return `Error reading file at ${args.path}: ${(error as Error).message}`;
      }
    }
  },
  writeFile: {
    openaiDefinition: {
      type: 'function',
      function: {
        name: 'writeFile',
        description: 'Create or overwrite a local file with new code or content.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The absolute or relative path to the file.' },
            content: { type: 'string', description: 'The full text content to write into the file.' }
          },
          required: ['path', 'content']
        }
      }
    },
    execute: (args: { path: string; content: string }): string => {
      try {
        fs.writeFileSync(args.path, args.content, 'utf8');
        return `Successfully wrote file to system at: ${args.path}`;
      } catch (error) {
        return `Error writing file at ${args.path}: ${(error as Error).message}`;
      }
    }
  },
  runCommand: {
    openaiDefinition: {
      type: 'function',
      function: {
        name: 'runCommand',
        description: 'Run local test commands on the Linux Mint system (e.g., pytest, ruff check).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to execute.' }
          },
          required: ['command']
        }
      }
    },
    execute: (args: { command: string }): Promise<string> => {
      return new Promise((resolve) => {
        exec.exec(args.command, (error, stdout, stderr) => {
          resolve(stdout || stderr || "Command executed with no output.");
        });
      });
    }
  }
};

const openaiToolsSpecs = Object.values(AGENT_TOOLS).map(tool => tool.openaiDefinition);

// ==========================================
// 3. CORE AGENT CLASS
// ==========================================
class CustomCodeAgent {
  private openai: OpenAI;
  private model: string;
  private memory: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  constructor() {
    this.openai = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1',
      apiKey: process.env.OPENAI_API_KEY || 'ollama',
    });
    this.model = process.env.AI_MODEL || 'llama3.2:3b';
  
    this.memory.push({
      role: 'system',
      content: `You are Custom-Code CLI, an elite autonomous DevOps and Backend automation agent. 
      You operate locally inside the user's Linux Mint host environment.
      1. To know where you are or list files, you MUST call the 'listDirectory' tool. Do NOT guess or hallucinate paths.
      2. Do NOT attempt to use 'readFile' on a directory path like '/'. It will fail.
      3. Be concise. Speak like a premium developer assistant.`
    });
  }

  public async processMessage(userInput: string, onToolExecution: (log: string) => void): Promise<string | null> {
    this.memory.push({ role: 'user', content: userInput });

    try {
      while (true) {
        const response = await this.openai.chat.completions.create({
          model: this.model,
          messages: this.memory,
          tools: openaiToolsSpecs,
          tool_choice: 'auto',
        });

        const assistantMessage = response.choices[0].message;
        this.memory.push(assistantMessage);

        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          return assistantMessage.content;
        }

        for (const toolCall of assistantMessage.tool_calls) {
          const { name: functionName, arguments: rawArgs } = toolCall.function;
          const registeredTool = AGENT_TOOLS[functionName];

          if (!registeredTool) {
            this.memory.push({ role: 'tool', tool_call_id: toolCall.id, content: `Error: ${functionName} not found.` });
            continue;
          }

          const parsedArgs = JSON.parse(rawArgs);
          onToolExecution(`⚡ Triggered: ${functionName}()`);

          const result = await registeredTool.execute(parsedArgs);
          this.memory.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
        }
      }
    } catch (error) {
      return `Error in execution lifecycle: ${(error as Error).message}`;
    }
  }
}

// ==========================================
// 4. INK UI TERMINAL APPLICATION
// ==========================================
const agent = new CustomCodeAgent();

function CustomCodeConsole() {
  const { exit } = useApp();
  const [query, setQuery] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<'idle' | 'thinking' | 'executing_tool'>('idle');
  const [agentResponse, setAgentResponse] = useState<string | null>(null);

  const handleSubmit = async (value: string) => {
    if (value.trim().toLowerCase() === 'exit') {
      exit();
      process.exit();
    }

    if (!value.trim()) return;

    setQuery('');
    setAgentResponse(null);
    setLogs([`User: ${value}`]);
    setStatus('thinking');

    const response = await agent.processMessage(value, (toolLog) => {
      setStatus('executing_tool');
      setLogs((prev) => [...prev, toolLog]);
    });

    setAgentResponse(response);
    setStatus('idle');
  };

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
      {/* HEADER BANNER */}
      <Box marginBottom={1}>
        <Text color="magenta" bold>=====| CUSTOM-CODE CLI |=====</Text>
      </Box>

      {/* STATUS INDICATOR */}
      <Box marginBottom={1}>
        <Text bold>System Status: </Text>
        {status === 'idle' && <Text color="green">● Online - Ready</Text>}
        {status === 'thinking' && <Text color="yellow">⏳ Processing neural graph...</Text>}
        {status === 'executing_tool' && <Text color="blue">⚙️ Autonomous System Tool Execution</Text>}
      </Box>

      {/* REAL-TIME SYSTEM LOGS */}
      {logs.map((log, index) => (
        <Box key={index} paddingLeft={1}>
          <Text color="gray">{log}</Text>
        </Box>
      ))}

      {/* AGENT FINAL RESPONSE BOX */}
      {agentResponse && (
        <Box marginTop={1} padding={1} borderStyle="single" borderColor="green" flexDirection="column">
          <Text color="green" bold>Custom-Code ➔</Text>
          <Text color="white">{agentResponse}</Text>
        </Box>
      )}

      {/* INTERACTIVE TEXT INPUT PROMPT */}
      <Box marginTop={1}>
        <Text color="magenta" bold>[Custom-Code] ➔ </Text>
        {status === 'idle' ? (
          <TextInput value={query} onChange={setQuery} onSubmit={handleSubmit} />
        ) : (
          <Text color="gray">System locked until process completes...</Text>
        )}
      </Box>
    </Box>
  );
}

console.clear();
render(<CustomCodeConsole />);
