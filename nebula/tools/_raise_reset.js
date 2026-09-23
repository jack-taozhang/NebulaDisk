(()=>{
  // 幂等：若已有窗口，说明本次会话是复用过的，先全部关掉，保证从干净状态开始
  const ws = Array.from(document.querySelectorAll('.window'));
  ws.forEach((w) => {
    const btn = w.querySelector('.tb-btn[data-act="close"], .tb-btn.close, [data-role="close"]');
    if (btn) btn.click();
  });
  return JSON.stringify({ closed: ws.length });
})()
