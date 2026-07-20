"use strict";
var __pure = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // core/menu-core/pure.ts
  var pure_exports = {};
  __export(pure_exports, {
    buildDisplayEntries: () => buildDisplayEntries,
    contextWindowFor: () => contextWindowFor,
    formatDuration: () => formatDuration,
    formatRelativeDate: () => formatRelativeDate,
    matchesVirtualPrefix: () => matchesVirtualPrefix,
    modelLabel: () => modelLabel,
    sortProjectEntries: () => sortProjectEntries,
    stripVirtualPrefix: () => stripVirtualPrefix
  });
  function isUpper(ch) {
    return ch.length === 1 && ch >= "A" && ch <= "Z";
  }
  function matchesVirtualPrefix(name, prefix) {
    if (name.length <= prefix.length || !name.startsWith(prefix)) return false;
    const lastPrefixChar = prefix[prefix.length - 1];
    if (lastPrefixChar === "-" || lastPrefixChar === "_") return true;
    return isUpper(name[prefix.length]);
  }
  function stripVirtualPrefix(name, prefix) {
    return name.slice(prefix.length);
  }
  function sortProjectEntries(projects, sortMode) {
    return [...projects].sort((a, b) => {
      if (sortMode === "alpha") {
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      }
      if (sortMode === "recent") {
        const lastA = a.lastUsed || "";
        const lastB = b.lastUsed || "";
        if (lastB !== lastA) return lastB.localeCompare(lastA);
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      }
      const countA = a.usageCount || 0;
      const countB = b.usageCount || 0;
      if (countB !== countA) return countB - countA;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  }
  function buildDisplayEntries(folderNames, virtualFolders, currentVirtualPrefix, virtualFoldersEnabled = true) {
    if (!virtualFoldersEnabled || virtualFolders.length === 0) {
      return folderNames.map((f) => ({ kind: "folder", name: f, displayName: f }));
    }
    if (currentVirtualPrefix) {
      return folderNames.filter((f) => matchesVirtualPrefix(f, currentVirtualPrefix)).map((f) => ({
        kind: "folder",
        name: f,
        displayName: stripVirtualPrefix(f, currentVirtualPrefix)
      }));
    }
    const matched = /* @__PURE__ */ new Set();
    const virtualEntries = [];
    for (const vf of virtualFolders) {
      const inGroup = folderNames.filter((f) => matchesVirtualPrefix(f, vf.prefix));
      inGroup.forEach((f) => matched.add(f));
      if (inGroup.length > 0) {
        virtualEntries.push({
          kind: "virtual",
          prefix: vf.prefix,
          title: vf.title,
          count: inGroup.length
        });
      }
    }
    virtualEntries.sort((a, b) => a.title.localeCompare(b.title));
    const regular = folderNames.filter((f) => !matched.has(f)).map((f) => ({ kind: "folder", name: f, displayName: f }));
    return [...virtualEntries, ...regular];
  }
  var CONTEXT_1M = 1e6;
  var CONTEXT_200K = 2e5;
  function modelLabel(modelId) {
    if (!modelId) return "unknown";
    const id = modelId.replace(/\[1m\]$/i, "");
    const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/i);
    if (!m) return modelId;
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return `${family} ${m[2]}.${m[3]}`;
  }
  function contextWindowFor(modelId) {
    if (/\[1m\]$/i.test(modelId)) return CONTEXT_1M;
    const fam = modelId.match(/^claude-([a-z]+)-/i)?.[1]?.toLowerCase();
    if (fam === "opus" || fam === "sonnet") return CONTEXT_1M;
    if (fam === "haiku") return CONTEXT_200K;
    return 0;
  }
  function formatRelativeDate(iso) {
    const date = new Date(iso);
    const now = /* @__PURE__ */ new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 6e4);
    const diffHr = Math.floor(diffMs / 36e5);
    const diffDays = Math.floor(diffMs / 864e5);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDays < 30) return `${diffDays}d ago`;
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  function formatDuration(iso) {
    const date = new Date(iso);
    const now = /* @__PURE__ */ new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 6e4);
    const diffHr = Math.floor(diffMs / 36e5);
    const diffDays = Math.floor(diffMs / 864e5);
    if (diffMin < 1) return "now";
    if (diffMin < 60) return `${diffMin}min`;
    if (diffHr < 24) return `${diffHr}h`;
    if (diffDays < 30) return `${diffDays}d`;
    const months = diffDays / 30.44;
    return `${months.toFixed(1)}m`;
  }
  return __toCommonJS(pure_exports);
})();
var matchesVirtualPrefix = __pure.matchesVirtualPrefix;
var stripVirtualPrefix = __pure.stripVirtualPrefix;
var sortProjectEntries = __pure.sortProjectEntries;
var buildDisplayEntries = __pure.buildDisplayEntries;
var modelLabel = __pure.modelLabel;
var contextWindowFor = __pure.contextWindowFor;
var formatRelativeDate = __pure.formatRelativeDate;
var formatDuration = __pure.formatDuration;
