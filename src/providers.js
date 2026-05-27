const AI_PROVIDER_PRESETS = [
  {
    id: "openai",
    label: "OpenAI",
    format: "openai-compatible",
    authType: "bearer",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4.1-mini",
    maxTokensField: "max_tokens",
    note: "OpenAI Chat Completions"
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    format: "anthropic",
    authType: "x-api-key",
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-4-20250514",
    apiVersion: "2023-06-01",
    maxTokensField: "max_tokens",
    note: "Anthropic Messages API"
  },
  {
    id: "gemini",
    label: "Google Gemini（有免费层）",
    format: "openai-compatible",
    authType: "bearer",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.5-flash",
    maxTokensField: "max_tokens",
    note: "Google AI Studio / Gemini OpenAI compatibility"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    format: "openai-compatible",
    authType: "bearer",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    maxTokensField: "max_tokens",
    note: "DeepSeek Chat Completions"
  },
  {
    id: "xiaomi-mimo",
    label: "Xiaomi MiMo",
    format: "openai-compatible",
    authType: "api-key",
    endpoint: "https://api.xiaomimimo.com/v1/chat/completions",
    model: "mimo-v2.5",
    maxTokensField: "max_completion_tokens",
    note: "Xiaomi MiMo OpenAI-compatible API"
  },
  {
    id: "minimax",
    label: "MiniMax",
    format: "openai-compatible",
    authType: "bearer",
    endpoint: "https://minimax-m2.com/api/v1/chat/completions",
    model: "MiniMax-M2.7-highspeed",
    maxTokensField: "max_completion_tokens",
    note: "MiniMax OpenAI-compatible API"
  },
  {
    id: "glm",
    label: "Z.ai / GLM",
    format: "openai-compatible",
    authType: "bearer",
    endpoint: "https://api.z.ai/api/paas/v4/chat/completions",
    model: "glm-5.1",
    maxTokensField: "max_tokens",
    note: "Z.ai GLM Chat Completions"
  },
  {
    id: "openrouter-free",
    label: "OpenRouter 免费模型",
    format: "openai-compatible",
    authType: "bearer",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "openrouter/free",
    maxTokensField: "max_tokens",
    note: "Routes to currently available free models on OpenRouter"
  },
  {
    id: "custom",
    label: "自定义（OpenAI 兼容）",
    format: "openai-compatible",
    authType: "bearer",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "your-model-id",
    maxTokensField: "max_tokens",
    note: "Custom OpenAI-compatible Chat Completions endpoint"
  }
];

function getAiProviderPreset(providerId) {
  return AI_PROVIDER_PRESETS.find((provider) => provider.id === providerId) || AI_PROVIDER_PRESETS[0];
}

function getDefaultAiProviderPreset() {
  return getAiProviderPreset("openai");
}
