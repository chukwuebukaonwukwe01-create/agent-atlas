// Registers Agent Atlas's page operations with the agent runtime. Only the names in
// agent-manifest.json "actions.agentTools" become model tools, called website_<name>.
// Each action wraps an App.page method the page's own controls also use.
import { App } from "./app.js";

class SiteActions {
  static registerActions(actions) {
    actions.register(SiteActions.getPageState());
    actions.register(SiteActions.showReport());
    actions.register(SiteActions.filterDirectory());
  }

  static getPageState() {
    return {
      name: "get_page_state",
      description: "Read which report is open on the page (its verdict, score, trust level, failed checks and warnings) and what the directory list shows.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => App.page.getState(),
    };
  }

  static showReport() {
    return {
      name: "show_report",
      description: "Run an Atlas check on a site and open the full report and network chart on the page. Returns the report digest, or ok false with a reason. Changes only what the page shows.",
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", minLength: 3, maxLength: 500, description: "The site, network or agent-manifest.json URL to check, exactly as the visitor or a tool result gave it." },
        },
      },
      execute: (args) => App.page.checkSite(args.url),
    };
  }

  static filterDirectory() {
    return {
      name: "filter_directory",
      description: "Filter the directory list on the page to sites matching some words, or show every site with an empty query. Returns the names shown. Changes only what the page shows.",
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", maxLength: 100, description: "Words to match, such as \"pizza\", or \"\" for every site." },
        },
      },
      execute: (args) => App.page.filterDirectory(args.query),
    };
  }
}

export const registerActions = SiteActions.registerActions;
