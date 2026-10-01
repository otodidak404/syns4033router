
import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Badge, Input, Modal, Select } from "@/shared/components";

const VALIDATION_TIMEOUT_MS = 15000;

async function fetchProviderNodeValidation(payload) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    const res = await fetch("/api/provider-nodes/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export default function EditCompatibleNodeModal({ isOpen, node, onSave, onClose, isAnthropic }) {
  const [formData, setFormData] = useState({
    name: "",
    prefix: "",
    apiType: "chat",
    baseUrl: "https://api.openai.com/v1",
  });
  const [saving, setSaving] = useState(false);
  const [checkKey, setCheckKey] = useState("");
  const [checkModelId, setCheckModelId] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);

  useEffect(() => {
    if (node) {
      setFormData({
        name: node.name || "",
        prefix: node.prefix || "",
        apiType: node.apiType || "chat",
        baseUrl: node.baseUrl || (isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"),
      });
    }
  }, [node, isAnthropic]);

  const apiTypeOptions = [
    { value: "chat", label: "Chat Completions" },
    { value: "responses", label: "Responses API" },
  ];

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: formData.name,
        prefix: formData.prefix,
        baseUrl: formData.baseUrl,
      };
      if (!isAnthropic) {
        payload.apiType = formData.apiType;
      }
      await onSave(payload);
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    let settled = false;
    const fallbackId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      setValidationResult({ valid: false, error: "Validation timeout (>15s)" });
      setValidating(false);
    }, VALIDATION_TIMEOUT_MS + 500);
    try {
      const data = await fetchProviderNodeValidation({
        baseUrl: formData.baseUrl,
        apiKey: checkKey,
        type: isAnthropic ? "anthropic-compatible" : "openai-compatible",
        modelId: checkModelId.trim() || undefined
      });
      if (settled) return;
      settled = true;
      setValidationResult(data);
    } catch (error) {
      if (settled) return;
      settled = true;
      setValidationResult({
        valid: false,
        error: error.name === "AbortError" ? "Validation timeout (>15s)" : "Network error",
      });
    } finally {
      window.clearTimeout(fallbackId);
      if (settled) setValidating(false);
    }
  };

  if (!node) return null;

  return (
    <Modal isOpen={isOpen} title={`Edit ${isAnthropic ? "Anthropic" : "OpenAI"} Compatible`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={`${isAnthropic ? "Anthropic" : "OpenAI"} Compatible (Prod)`}
          hint="Required. A friendly label for this node."
        />
        <Input
          label="Prefix"
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder={isAnthropic ? "ac-prod" : "oc-prod"}
          hint="Required. Used as the provider prefix for model IDs."
        />
        {!isAnthropic && (
          <Select
            label="API Type"
            options={apiTypeOptions}
            value={formData.apiType}
            onChange={(e) => setFormData({ ...formData, apiType: e.target.value })}
          />
        )}
        <Input
          label="Base URL"
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder={isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
          hint={`Use the base URL (ending in /v1) for your ${isAnthropic ? "Anthropic" : "OpenAI"}-compatible API.`}
        />
        <div className="flex gap-2">
          <Input
            label="API Key (for Check)"
            type="password"
            value={checkKey}
            onChange={(e) => setCheckKey(e.target.value)}
            className="flex-1"
          />
          <div className="pt-6">
            <Button onClick={handleValidate} disabled={!checkKey || validating || !formData.baseUrl.trim()} variant="secondary">
              {validating ? "Checking..." : "Check"}
            </Button>
          </div>
        </div>
        <Input
          label="Model ID (optional)"
          value={checkModelId}
          onChange={(e) => setCheckModelId(e.target.value)}
          placeholder="e.g. my-model-id"
          hint="If provider lacks /models endpoint, enter a model ID to validate via chat/completions instead."
        />
        {validationResult && (
          <div className="flex flex-col gap-1">
            <Badge variant={validationResult.valid ? "success" : "error"}>
              {validationResult.valid ? "Valid" : "Invalid"}
            </Badge>
            {!validationResult.valid && validationResult.error && (
              <span className="text-sm text-red-500">{validationResult.error}</span>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim() || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

EditCompatibleNodeModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  node: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    prefix: PropTypes.string,
    apiType: PropTypes.string,
    baseUrl: PropTypes.string,
  }),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  isAnthropic: PropTypes.bool,
};
