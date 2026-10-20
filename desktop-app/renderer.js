const navItems = [...document.querySelectorAll("[data-view]")];
const views = [...document.querySelectorAll(".view")];
const breadcrumb = document.querySelector("#breadcrumb-view");
const toast = document.querySelector("#toast");
const chooseButton = document.querySelector("#choose-target");
const selectedTarget = document.querySelector("#selected-target");
const startButton = document.querySelector("#start-investigation");
const targetName = document.querySelector("#target-name");
const targetPath = document.querySelector("#target-path");
const workflowStatus = document.querySelector("#workflow-status");
const workflowTitle = document.querySelector("#workflow-title");
const workflowMessage = document.querySelector("#workflow-message");
const rebuildOffer = document.querySelector("#rebuild-offer");
const rebuildButton = document.querySelector("#create-rebuild");
let investigation;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 3000);
}

function openView(name) {
  const label = name[0].toUpperCase() + name.slice(1);
  views.forEach((view) =>
    view.classList.toggle("active-view", view.id === `view-${name}`),
  );
  document
    .querySelectorAll(".nav-item")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.view === name),
    );
  breadcrumb.textContent = label;
}

navItems.forEach((item) =>
  item.addEventListener("click", () => openView(item.dataset.view)),
);

chooseButton.addEventListener("click", async () => {
  const target = await window.reaDesktop.chooseTarget();
  if (!target) return;
  const parts = target.split(/[\\/]/);
  targetName.textContent = parts.at(-1) || target;
  targetPath.textContent = target;
  chooseButton.hidden = true;
  selectedTarget.hidden = false;
  startButton.disabled = false;
  showToast("Target attached to this investigation");
});

document.querySelector("#clear-target").addEventListener("click", () => {
  chooseButton.hidden = false;
  selectedTarget.hidden = true;
  startButton.disabled = true;
});

startButton.addEventListener("click", () => {
  if (
    !targetPath.textContent ||
    targetPath.textContent === "Choose a file or folder to begin"
  )
    return;
  startButton.disabled = true;
  rebuildOffer.hidden = true;
  workflowStatus.hidden = false;
  workflowStatus.className = "workflow-status";
  workflowTitle.textContent = "Reversal in progress";
  workflowMessage.textContent = "Starting a bounded local REA analysis…";
  window.reaDesktop
    .analyzeTarget(targetPath.textContent)
    .then((result) => {
      investigation = result;
      workflowStatus.className = "workflow-status done";
      workflowTitle.textContent = "Reversal complete";
      workflowMessage.textContent = `Evidence report ready · ${result.route}`;
      rebuildOffer.hidden = false;
      showToast("Evidence-backed reversal completed");
    })
    .catch((error) => {
      workflowStatus.className = "workflow-status error";
      workflowTitle.textContent = "Reversal stopped";
      workflowMessage.textContent =
        error.message || "REA could not complete the selected workflow";
      startButton.disabled = false;
      showToast("Analysis failed — see the workflow status");
    });
});

window.reaDesktop.onAnalysisProgress((progress) => {
  workflowStatus.hidden = false;
  workflowMessage.textContent = progress.message;
});

rebuildButton.addEventListener("click", async () => {
  if (!investigation) return;
  const destination = await window.reaDesktop.chooseRebuildDirectory();
  if (!destination) return;
  rebuildButton.disabled = true;
  rebuildButton.textContent = "Creating…";
  try {
    const result = await window.reaDesktop.createRebuild({
      destination,
      investigation,
    });
    rebuildButton.textContent = "Open rebuild folder";
    rebuildButton.disabled = false;
    rebuildButton.onclick = () =>
      window.reaDesktop.openFolder(result.projectRoot);
    workflowTitle.textContent = "Rebuild workspace created";
    workflowMessage.textContent = result.projectRoot;
    showToast("Independent open-source rebuild workspace created");
  } catch (error) {
    rebuildButton.disabled = false;
    rebuildButton.textContent = "Create rebuild ↗";
    showToast(error.message || "Could not create rebuild workspace");
  }
});

document
  .querySelector("#refresh-button")
  .addEventListener("click", () => showToast("Readiness checked locally"));
document
  .querySelector("#paste-target")
  .addEventListener("click", () => showToast("Paste a path with Ctrl + V"));
document
  .querySelector("#docs-button")
  .addEventListener("click", () => window.reaDesktop.openDocs());

document.addEventListener("dragover", (event) => {
  event.preventDefault();
  chooseButton.classList.add("dragging");
});
document.addEventListener("dragleave", () =>
  chooseButton.classList.remove("dragging"),
);
document.addEventListener("drop", (event) => {
  event.preventDefault();
  chooseButton.classList.remove("dragging");
  showToast("Use Choose a file or folder to attach a local target");
});

window.reaDesktop.getSystemInfo().then((info) => {
  const ghidraReadiness = document.querySelector("#ghidra-readiness");
  const ghidraStatus = document.querySelector("#ghidra-status");
  const ghidraDetailStatus = document.querySelector("#ghidra-detail-status");
  const ghidraPath = document.querySelector("#ghidra-path");

  ghidraReadiness.textContent = info.ghidraAvailable
    ? `Launcher found at ${info.ghidraLauncherPath}`
    : `Launcher not found at ${info.ghidraLauncherPath}`;
  ghidraStatus.textContent = info.ghidraAvailable ? "READY" : "NOT FOUND";
  ghidraDetailStatus.textContent = info.ghidraAvailable
    ? "READY"
    : "PATH NOT FOUND";
  ghidraPath.textContent = info.ghidraLauncherPath;
  if (info.ghidraAvailable) {
    ghidraStatus.className = "ready-tag";
    ghidraDetailStatus.className = "ready-tag";
  }

  document.querySelectorAll(".provider-detail p").forEach((node) => {
    if (node.textContent.startsWith("Static module"))
      node.parentElement.querySelector(
        ".detail-footer span:last-child",
      ).textContent = `Node ${info.node}`;
  });
});
