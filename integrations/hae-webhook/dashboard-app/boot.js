(async () => {
  try {
    const packed = document.getElementById("dashboard-bundle");
    const bytes = Uint8Array.from(atob(packed.textContent), (char) => char.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const script = document.createElement("script");
    script.textContent = await new Response(stream).text();
    document.body.appendChild(script);
    packed.remove();
  } catch {
    document.getElementById("root").textContent = "看板资源加载失败，请刷新页面或更新飞书客户端后重试。";
  }
})();
