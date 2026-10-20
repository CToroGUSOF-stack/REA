document.querySelector("#export").addEventListener("click", async () => {
  await window.prototype.export("fixture exported\n");
  document.querySelector("#flush").hidden = false;
});
document.querySelector("#flush").addEventListener("click", async () => {
  await window.prototype.flush();
  document.querySelector("#flushed").hidden = false;
});
