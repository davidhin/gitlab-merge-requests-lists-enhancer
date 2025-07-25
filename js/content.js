(function (globals) {
  "use strict";

  class GitLabApiClient {
    /**
     * The GitLab API client used by the extension. No tokens or authentication needed as every requests are
     * performed from inside the context of the page (GitLab allows API calls if they comes from the site).
     */
    constructor(baseUrl, csrfToken) {
      this.baseUrl = baseUrl;
      this.csrfToken = csrfToken;
    }

    /**
     * Returns the full URL to the given GitLab API endpoint.
     */
    createEndpointUrl(endpoint, queryStringParameters = null) {
      let endpointUrl = new URL(this.baseUrl + endpoint);

      if (queryStringParameters) {
        queryStringParameters.forEach(function (queryStringParameter) {
          endpointUrl.searchParams.append(
            queryStringParameter[0],
            queryStringParameter[1]
          );
        });
      }

      return endpointUrl.toString();
    }

    /**
     * Sends an HTTP request to the GitLab API.
     */
    sendRequest(method, endpoint, queryStringParameters = null, data = null) {
      let headers = {};
      let body = null;

      if (["post", "put", "patch"].includes(method.toLowerCase())) {
        if (!this.csrfToken) {
          console.error(
            "Cannot issue POST/PUT/PATCH requests without CSRF token"
          );

          return;
        }

        headers["X-CSRF-Token"] = this.csrfToken;
      }

      if (data) {
        headers["Content-Type"] = "application/json";

        body = JSON.stringify(data);
      }

      let fetchPromise = fetch(
        this.createEndpointUrl(endpoint, queryStringParameters),
        {
          method: method,
          headers: headers,
          body: body,
          credentials: "same-origin",
        }
      ).then(function (response) {
        if (response.ok) {
          return response.json();
        } else {
          return Promise.reject(response);
        }
      });

      fetchPromise.catch(function (err) {
        console.error("Got error from GitLab:", err);

        alert("Got error from GitLab, check console for more information.");
      });

      return fetchPromise;
    }

    /**
     * Fetch details about the given Merge Requests IDs in the given project ID.
     */
    getProjectMergeRequests(projectId, mergeRequestIds) {
      let queryStringParameters = mergeRequestIds.map(function (
        mergeRequestId
      ) {
        return ["iids[]", mergeRequestId];
      });

      return this.sendRequest(
        "GET",
        "projects/" + projectId + "/merge_requests",
        queryStringParameters
      );
    }

    /**
     * Update the given Merge Request Id in the given project ID.
     */
    updateProjectMergeRequest(projectId, mergeRequestId, data) {
      let dataToSend = {
        id: parseInt(projectId, 10),
        merge_request_iid: parseInt(mergeRequestId, 10),
      };

      Object.assign(dataToSend, data);

      return this.sendRequest(
        "PUT",
        "projects/" + projectId + "/merge_requests/" + mergeRequestId,
        null,
        dataToSend
      );
    }
  }

  class ContentScript {
    /**
     * The content script of the extension which is executed in the context of the page.
     */
    constructor() {
      console.log("🔧 GitLab MR Enhancer: Extension starting...");
      console.log(
        "🔧 GitLab MR Enhancer: Current page URL:",
        window.location.href
      );
      console.log("🔧 GitLab MR Enhancer: Page title:", document.title);

      // Add visible debug element to UI
      this.addDebugElement();

      this.currentProjectId = this.getCurrentProjectId();
      console.log("🔧 GitLab MR Enhancer: Project ID:", this.currentProjectId);

      if (!this.currentProjectId) {
        console.error(
          "❌ GitLab MR Enhancer: Aborting: current project ID cannot be found"
        );
        console.log(
          "🔧 GitLab MR Enhancer: Available body data attributes:",
          Object.keys(document.body?.dataset || {})
        );
        return;
      }

      this.baseProjectUrl = this.getBaseProjectUrl();
      console.log(
        "🔧 GitLab MR Enhancer: Base project URL:",
        this.baseProjectUrl
      );

      if (!this.baseProjectUrl) {
        console.error(
          "❌ GitLab MR Enhancer: Aborting: base project URL cannot be found"
        );
        return;
      }

      this.baseUrl = location.protocol + "//" + location.host;
      this.baseApiUrl = this.baseUrl + "/api/v4/";
      this.baseIconsUrl = this.getBaseIconsUrl();
      this.userAuthenticated = this.isUserAuthenticated();
      this.pipelineFeatureEnabled = this.isPipelineFeatureEnabled();
      this.apiClient = new GitLabApiClient(
        this.baseApiUrl,
        this.getCsrfToken()
      );

      let preferencesManager = new globals.Gmrle.PreferencesManager();

      let self = this;

      preferencesManager.getAll(function (preferences) {
        console.log("🔧 GitLab MR Enhancer: Preferences loaded:", preferences);
        self.preferences = preferences;
        self.waitForMergeRequestsAndProcess();
      });
    }

    /**
     * Adds a visible debug element to the UI to show the extension is running
     */
    addDebugElement() {
      const debugDiv = document.createElement("div");
      debugDiv.style.cssText = `
                position: fixed;
                top: 10px;
                right: 10px;
                background: #ff6b6b;
                color: white;
                padding: 8px 12px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: bold;
                z-index: 9999;
                box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            `;
      debugDiv.textContent = "🔧 GitLab MR Enhancer Active";
      document.body.appendChild(debugDiv);

      // Remove after 5 seconds
      setTimeout(() => {
        if (debugDiv.parentNode) {
          debugDiv.parentNode.removeChild(debugDiv);
        }
      }, 5000);
    }

    /**
     * Finds and returns the GitLab project ID whe're looking merge requests at.
     */
    getCurrentProjectId() {
      let body = document.querySelector("body");

      if (!body || !("projectId" in body.dataset)) {
        return null;
      }

      return body.dataset.projectId;
    }

    /**
     * Finds and returns the URI to the project whe're looking merge requests at.
     */
    getBaseProjectUrl() {
      console.log("🔧 GitLab MR Enhancer: Looking for project URL...");

      // Try multiple selectors to find the project URL
      const selectors = [
        ".nav-sidebar .context-header a",
        ".sidebar-context-header a",
        ".context-header a",
        '[data-testid="project-link"]',
        ".project-link",
        '.sidebar-top-level-items a[href*="/-/"]',
      ];

      for (let selector of selectors) {
        let link = document.querySelector(selector);
        if (link) {
          const href = link.getAttribute("href");
          console.log(
            '🔧 GitLab MR Enhancer: Found project URL with selector "' +
              selector +
              '":',
            href
          );
          return href;
        }
      }

      // Fallback: try to extract from current URL
      const currentUrl = window.location.href;
      console.log("🔧 GitLab MR Enhancer: Current URL:", currentUrl);

      // Extract project path from URL like: https://gitlab.com/group/project/-/merge_requests
      // Handle both 2-level (group/project) and 3-level (group/subgroup/project) paths
      const urlMatch = currentUrl.match(
        /(https?:\/\/[^\/]+)(\/[^\/]+\/[^\/]+\/[^\/]+)\/-\//
      );
      if (urlMatch) {
        const projectUrl = urlMatch[1] + urlMatch[2];
        console.log(
          "🔧 GitLab MR Enhancer: Extracted project URL from current URL:",
          projectUrl
        );
        return projectUrl;
      }

      // Fallback for 2-level paths: group/project
      const pathMatch = currentUrl.match(
        /(https?:\/\/[^\/]+)(\/[^\/]+\/[^\/]+)\/-\//
      );
      if (pathMatch) {
        const projectUrl = pathMatch[1] + pathMatch[2];
        console.log(
          "🔧 GitLab MR Enhancer: Extracted project URL (2-level path):",
          projectUrl
        );
        return projectUrl;
      }

      console.error(
        "❌ GitLab MR Enhancer: Could not find project URL with any selector or URL extraction"
      );
      return null;
    }

    /**
     * Get the current CSRF token that should be sent in any subsequent POST or PUT requests to the Gitlab API.
     */
    getCsrfToken() {
      let meta = document.querySelector('meta[name="csrf-token"]');

      return meta ? meta.getAttribute("content") : null;
    }

    /**
     * Determines if the current user is logged-in to GitLab.
     */
    isUserAuthenticated() {
      return document.querySelector(".navbar-nav .header-user") ? true : false;
    }

    /**
     * Return the base URL to the SVG icons file.
     */
    getBaseIconsUrl() {
      let svgUse = document.querySelector("svg.s16 > use");

      if (!svgUse || !svgUse.href.baseVal) {
        return null;
      }

      let url = svgUse.href.baseVal;

      if (url.startsWith("/")) {
        url = this.baseUrl + url;
      }

      let parsedUrl = new URL(url);

      return (
        parsedUrl.protocol + "//" + parsedUrl.host + "/" + parsedUrl.pathname
      );
    }

    /**
     * Determines if the project do uses the Gitlab "pipeline" feature.
     */
    isPipelineFeatureEnabled() {
      return document.querySelector(".nav-sidebar .shortcuts-pipelines")
        ? true
        : false;
    }

    /**
     * Waits for merge requests to load in the DOM and then processes them
     */
    waitForMergeRequestsAndProcess() {
      console.log(
        "🔧 GitLab MR Enhancer: Waiting for merge requests to load..."
      );

      const maxAttempts = 10;
      let attempts = 0;

      const checkForMergeRequests = () => {
        attempts++;
        console.log(
          `🔧 GitLab MR Enhancer: Attempt ${attempts}/${maxAttempts} to find merge requests`
        );

        // Try multiple selectors to find merge request elements
        const selectors = [
          ".mr-list .merge-request .issuable-reference",
          ".merge-request .issuable-reference",
          '[data-testid="merge-request-item"] .issuable-reference',
          ".gl-list-item .issuable-reference",
        ];

        let mrElements = [];
        for (let selector of selectors) {
          mrElements = document.querySelectorAll(selector);
          if (mrElements.length > 0) {
            console.log(
              `🔧 GitLab MR Enhancer: Found ${mrElements.length} MR elements using selector: ${selector}`
            );
            break;
          }
        }

        if (mrElements.length > 0) {
          // Found merge requests, process them
          this.currentMergeRequestIds = this.getCurrentMergeRequestIds();
          console.log(
            "🔧 GitLab MR Enhancer: Found MR IDs:",
            this.currentMergeRequestIds
          );
          this.fetchMergeRequestsDetailsThenUpdateUI(
            this.currentMergeRequestIds
          );
        } else if (attempts < maxAttempts) {
          // Wait 1 second and try again
          console.log(
            "🔧 GitLab MR Enhancer: No merge requests found, retrying in 1 second..."
          );
          setTimeout(checkForMergeRequests, 1000);
        } else {
          console.error(
            "❌ GitLab MR Enhancer: Could not find merge requests after",
            maxAttempts,
            "attempts"
          );
        }
      };

      checkForMergeRequests();
    }

    /**
     * Gets all Merge Requests IDs that are currently displayed.
     */
    getCurrentMergeRequestIds() {
      // Try multiple selectors to find merge request elements
      const selectors = [
        ".mr-list .merge-request .issuable-reference",
        ".merge-request .issuable-reference",
        '[data-testid="merge-request-item"] .issuable-reference',
        ".gl-list-item .issuable-reference",
      ];

      let mrElements = [];
      let usedSelector = "";

      for (let selector of selectors) {
        mrElements = document.querySelectorAll(selector);
        if (mrElements.length > 0) {
          usedSelector = selector;
          break;
        }
      }

      console.log(
        "🔧 GitLab MR Enhancer: Found",
        mrElements.length,
        "MR elements in DOM using selector:",
        usedSelector
      );

      // Debug: Show the first few MR elements and their structure
      const firstFewElements = Array.from(mrElements).slice(0, 3);
      firstFewElements.forEach((el, index) => {
        console.log("🔧 GitLab MR Enhancer: MR element", index + 1, ":", {
          text: el.textContent.trim(),
          parentClasses: el.parentElement?.className,
          parentDataAttrs: el.parentElement?.dataset,
        });
      });

      const mrIds = Array.from(mrElements).map(function (el) {
        const id = el.textContent.trim().replace("!", "");
        console.log("🔧 GitLab MR Enhancer: Found MR ID in DOM:", id);
        return id;
      });

      return mrIds;
    }

    /**
     * Performs an HTTP GET request to the GitLab API to retrieve details about Merge Requests that are
     * currently displayed. If successful, it actually updates the UI by altering the DOM.
     */
    fetchMergeRequestsDetailsThenUpdateUI(mergeRequestIds) {
      let self = this;

      console.log(
        "🔧 GitLab MR Enhancer: Fetching MR details for IDs:",
        mergeRequestIds
      );
      console.log(
        "🔧 GitLab MR Enhancer: Display branches setting:",
        self.preferences.display_source_and_target_branches
      );

      // Debug: Check what's in the DOM right now
      console.log("🔧 GitLab MR Enhancer: Current DOM state:");
      const allElements = document.querySelectorAll("*");
      console.log(
        "🔧 GitLab MR Enhancer: Total elements in DOM:",
        allElements.length
      );

      const mrListElements = document.querySelectorAll(".mr-list");
      console.log(
        "🔧 GitLab MR Enhancer: .mr-list elements found:",
        mrListElements.length
      );

      const mergeRequestElements = document.querySelectorAll(".merge-request");
      console.log(
        "🔧 GitLab MR Enhancer: .merge-request elements found:",
        mergeRequestElements.length
      );

      this.apiClient
        .getProjectMergeRequests(this.currentProjectId, mergeRequestIds)
        .then(function (responseData) {
          console.log(
            "🔧 GitLab MR Enhancer: API response received:",
            responseData
          );

          if (self.preferences.display_source_and_target_branches) {
            console.log(
              "🔧 GitLab MR Enhancer: Removing existing branch nodes"
            );
            self.removeExistingTargetBranchNodes();
          }

          console.log("🔧 GitLab MR Enhancer: Updating MR nodes");
          self.updateMergeRequestsNodes(responseData);
        })
        .catch(function (error) {
          console.error(
            "❌ GitLab MR Enhancer: Error fetching MR details:",
            error
          );
        });
    }

    /**
     * Removes all branches that may have been already displayed by GitLab.
     */
    removeExistingTargetBranchNodes() {
      document
        .querySelectorAll(".mr-list .merge-request .project-ref-path")
        .forEach(function (el) {
          el.parentNode.removeChild(el);
        });
    }

    /**
     * Parses HTML code and applies a callback on all of the parsed root DOM nodes.
     */
    parseHtml(html, callback) {
      new DOMParser()
        .parseFromString(html, "text/html")
        .querySelector("body")
        .childNodes.forEach(function (node) {
          callback(node);
        });
    }

    /**
     * Prepends the given HTML string at the beginning of the given child target node.
     */
    parseHtmlAndPrepend(targetNode, html) {
      this.parseHtml(html, function (node) {
        targetNode.prepend(node);
      });
    }

    /**
     * Appends the given HTML string at the end of the given child target node.
     */
    parseHtmlAndAppend(targetNode, html) {
      this.parseHtml(html, function (node) {
        targetNode.append(node);
      });
    }

    /**
     * Inserts the given HTML string before the given child target node.
     */
    parseHtmlAndInsertBefore(targetNode, html) {
      this.parseHtml(html, function (node) {
        targetNode.parentNode.insertBefore(node, targetNode);
      });
    }

    /**
     * Actually updates the UI by altering the DOM by adding our stuff.
     */
    updateMergeRequestsNodes(mergeRequests) {
      console.log(
        "🔧 GitLab MR Enhancer: Updating",
        mergeRequests.length,
        "merge requests"
      );

      mergeRequests.forEach(function (mergeRequest) {
        console.log(
          "🔧 GitLab MR Enhancer: Processing MR",
          mergeRequest.iid,
          "with branches:",
          mergeRequest.source_branch,
          "->",
          mergeRequest.target_branch
        );

        // Try multiple selectors to find the MR node
        let mergeRequestNode = null;
        const selectors = [
          '.merge-request[data-qa-issue-id="' + mergeRequest.id + '"]',
          '.merge-request[data-id="' + mergeRequest.id + '"]',
          '.merge-request[data-iid="' + mergeRequest.iid + '"]',
          '.merge-request:has(.issuable-reference:contains("!' +
            mergeRequest.iid +
            '"))',
          ".merge-request",
        ];

        // Try each selector
        for (let selector of selectors) {
          if (selector.includes(":has") || selector.includes(":contains")) {
            // For complex selectors, we need to manually check
            const allMrNodes = document.querySelectorAll(".merge-request");
            console.log(
              "🔧 GitLab MR Enhancer: Found",
              allMrNodes.length,
              "MR nodes in DOM"
            );

            // Debug: Show all available MR nodes
            if (allMrNodes.length === 0) {
              console.log(
                "🔧 GitLab MR Enhancer: No MR nodes found, checking alternative selectors..."
              );
              const alternativeSelectors = [
                ".merge-request",
                ".gl-list-item",
                '[data-testid="merge-request-item"]',
                ".mr-list > *",
              ];

              alternativeSelectors.forEach((altSelector) => {
                const altNodes = document.querySelectorAll(altSelector);
                console.log(
                  `🔧 GitLab MR Enhancer: Found ${altNodes.length} nodes with selector: ${altSelector}`
                );
                if (altNodes.length > 0) {
                  console.log(
                    "🔧 GitLab MR Enhancer: First node classes:",
                    altNodes[0].className
                  );
                  console.log(
                    "🔧 GitLab MR Enhancer: First node HTML:",
                    altNodes[0].outerHTML.substring(0, 200) + "..."
                  );
                }
              });
            }

            for (let node of allMrNodes) {
              const referenceEl = node.querySelector(".issuable-reference");
              if (referenceEl) {
                console.log(
                  "🔧 GitLab MR Enhancer: MR node reference text:",
                  referenceEl.textContent.trim()
                );
              }
              if (
                referenceEl &&
                referenceEl.textContent.includes("!" + mergeRequest.iid)
              ) {
                mergeRequestNode = node;
                console.log(
                  "🔧 GitLab MR Enhancer: Found MR node using manual search for IID:",
                  mergeRequest.iid
                );
                break;
              }
            }
            if (mergeRequestNode) break;
          } else {
            mergeRequestNode = document.querySelector(selector);
            if (mergeRequestNode) {
              console.log(
                "🔧 GitLab MR Enhancer: Found MR node using selector:",
                selector
              );
              break;
            }
          }
        }

        if (!mergeRequestNode) {
          console.error(
            "❌ GitLab MR Enhancer: Could not find MR node for IID:",
            mergeRequest.iid,
            "or ID:",
            mergeRequest.id
          );
          return;
        }

        this.setDataAttributesToMergeRequestNode(
          mergeRequestNode,
          mergeRequest
        );

        

        // -----------------------------------------------
        // Source branch info only

        if (this.preferences.display_source_and_target_branches) {
          console.log(
            "🔧 GitLab MR Enhancer: Adding source branch info for MR",
            mergeRequest.iid
          );

          let newInfoLineToInject = '<div class="issuable-info">';

          // Source branch name only
          newInfoLineToInject +=
            '<span class="project-ref-path has-tooltip" title="Source branch">' +
            '<a class="ref-name" href="' +
            this.baseProjectUrl +
            "/-/commits/" +
            mergeRequest.source_branch +
            '">' +
            mergeRequest.source_branch +
            "</a>" +
            "</span>";

          newInfoLineToInject += "</div>";

          console.log(
            "🔧 GitLab MR Enhancer: Branch HTML to inject:",
            newInfoLineToInject
          );

          const targetElement = mergeRequestNode.querySelector(
            ".issuable-main-info"
          );
          if (targetElement) {
            console.log(
              "🔧 GitLab MR Enhancer: Found target element, injecting branch info"
            );
            this.parseHtmlAndAppend(targetElement, newInfoLineToInject);
          } else {
            console.error(
              "❌ GitLab MR Enhancer: Could not find .issuable-main-info element for MR",
              mergeRequest.iid
            );
          }
        } else {
          console.log(
            "🔧 GitLab MR Enhancer: Branch display is disabled in preferences"
          );
        }

        
      }, this);
    }

    /**
     * Sets several data-* attributes on a DOM node representing a Merge Request so these values may be used later.
     */
    setDataAttributesToMergeRequestNode(mergeRequestNode, mergeRequest) {
      mergeRequestNode.dataset.title = mergeRequest.title;
      mergeRequestNode.dataset.iid = mergeRequest.iid;
      mergeRequestNode.dataset.url = mergeRequest.web_url;
      mergeRequestNode.dataset.diffsUrl = mergeRequest.web_url + "/diffs";
      mergeRequestNode.dataset.authorName = mergeRequest.author.name;
      mergeRequestNode.dataset.status = mergeRequest.state;
      mergeRequestNode.dataset.sourceBranchName = mergeRequest.source_branch;
      mergeRequestNode.dataset.targetBranchName = mergeRequest.target_branch;
      mergeRequestNode.dataset.isWip = mergeRequest.work_in_progress;

      
    }

    /**
     * Finds a Jira ticket ID in the given Merge Request object. It first tris in the source branch name, then
     * fallbacks to the Merge Request title.
     */
    findFirstJiraTicketId(mergeRequest) {
      let jiraTicketIdRegex = new RegExp("[A-Z]{1,10}-\\d+");

      // First try in the source branch name
      let results = jiraTicketIdRegex.exec(mergeRequest.source_branch);

      if (results) {
        return results[0];
      }

      // Fallback to the Merge Request title if none found in the source branch name
      results = jiraTicketIdRegex.exec(mergeRequest.title);

      if (results) {
        return results[0];
      }

      return null;
    }

    /**
     * Creates an URL to a given Jira ticket ID, pointing to the Jira base URL the user has defined in its
     * preferences.
     */
    createJiraTicketUrl(jiraTicketId) {
      let baseJiraUrl = new URL(this.preferences.base_jira_url);

      if (!baseJiraUrl.pathname.endsWith("/")) {
        baseJiraUrl.pathname += "/";
      }

      baseJiraUrl.pathname += "browse/" + jiraTicketId;

      return baseJiraUrl.toString();
    }

    /**
     * Attach a click event to all buttons inserted by the extension allowing to copy the source and target
     * branches name.
     */
    attachClickEventToCopyBranchNameButtons() {
      document
        .querySelectorAll("button.gmrle-copy-branch-name")
        .forEach(function (el) {
          el.addEventListener("click", function (e) {
            e.preventDefault();

            let branchName =
              this.closest(".merge-request").dataset[
                this.dataset.branchNameToCopy + "BranchName"
              ];

            navigator.clipboard.writeText(branchName).then(
              function () {
                // Do nothing if copy was successful.
              },
              function () {
                alert("Unable to copy branch name.");
              }
            );
          });
        });
    }

    /**
     * Attach a click event to all buttons inserted by the extension allowing to copy Merge Request info.
     */
    attachClickEventToCopyMergeRequestInfoButtons() {
      let self = this;

      document
        .querySelectorAll("button.gmrle-copy-mr-info")
        .forEach(function (el) {
          el.addEventListener("click", function (e) {
            e.preventDefault();

            let text = self.buildMergeRequestInfoText(
              this.closest(".merge-request")
            );

            navigator.clipboard.writeText(text).then(
              function () {
                // Do nothing if copy was successful.
              },
              function () {
                alert("Unable to copy Merge Request info.");
              }
            );
          });
        });
    }

    /**
     * Attach a click event to all buttons inserted by the extension allowing to toggle Merge Request WIP status.
     */
    attachClickEventToToggleWipStatusButtons() {
      let self = this;

      document
        .querySelectorAll("button.gmrle-toggle-wip-status")
        .forEach(function (el) {
          el.addEventListener("click", function (e) {
            e.preventDefault();

            self.toggleMergeRequestWipStatus(
              this.closest(".merge-request"),
              this
            );
          });
        });
    }

    /**
     * Actually toggle a given Merge Request WIP status.
     */
    toggleMergeRequestWipStatus(mergeRequestNode, toggleButton) {
      toggleButton.disabled = true;

      let isWip = mergeRequestNode.dataset.isWip == "true";
      let newTitle = "";

      if (isWip) {
        newTitle = mergeRequestNode.dataset.title
          .replace(new RegExp("^WIP:"), "")
          .trim();
      } else {
        newTitle = "WIP: " + mergeRequestNode.dataset.title.trim();
      }

      this.apiClient
        .updateProjectMergeRequest(
          this.currentProjectId,
          mergeRequestNode.dataset.iid,
          {
            title: newTitle,
          }
        )
        .then(function (responseData) {
          mergeRequestNode.dataset.isWip = responseData.work_in_progress;
          mergeRequestNode.dataset.title = responseData.title;

          mergeRequestNode.querySelector(
            ".merge-request-title-text a"
          ).textContent = responseData.title;
        })
        .finally(function () {
          toggleButton.disabled = false;
        });
    }

    /**
     * Creates the Merge Request info text from a Merge Request container DOM node.
     */
    buildMergeRequestInfoText(mergeRequestNode) {
      let placeholders = {
        MR_TITLE: mergeRequestNode.dataset.title,
        MR_ID: mergeRequestNode.dataset.iid,
        MR_URL: mergeRequestNode.dataset.url,
        MR_DIFFS_URL: mergeRequestNode.dataset.diffsUrl,
        MR_AUTHOR_NAME: mergeRequestNode.dataset.authorName,
        MR_STATUS: mergeRequestNode.dataset.status,
        MR_SOURCE_BRANCH_NAME: mergeRequestNode.dataset.sourceBranchName,
        MR_TARGET_BRANCH_NAME: mergeRequestNode.dataset.targetBranchName,
        MR_JIRA_TICKET_ID:
          "jiraTicketId" in mergeRequestNode.dataset
            ? mergeRequestNode.dataset.jiraTicketId
            : "",
        MR_JIRA_TICKET_URL:
          "jiraTicketUrl" in mergeRequestNode.dataset
            ? mergeRequestNode.dataset.jiraTicketUrl
            : "",
      };

      let placeholdersReplaceRegex = new RegExp(
        "{(" + Object.keys(placeholders).join("|") + ")}",
        "g"
      );

      return this.preferences.copy_mr_info_format
        .replace(placeholdersReplaceRegex, function (_, placeholder) {
          return placeholders[placeholder];
        })
        .trim();
    }

    /**
     * Generate the HTML code corresponding to an SVG icon.
     */
    buildSpriteIcon(iconName, classes = "") {
      return (
        '<svg class="s16 ' +
        classes +
        '" data-testid="' +
        iconName +
        '-icon">' +
        '<use xlink:href="' +
        this.baseIconsUrl +
        "#" +
        iconName +
        '"></use>' +
        "</svg>"
      );
    }
  }

  let cs = new ContentScript();
})(this);
