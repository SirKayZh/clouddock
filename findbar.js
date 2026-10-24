/* 页内查找浮层：盖在网页 WebContentsView 之上的小浮层视图（主进程定位在网页区右上角）。
 * 输入即搜（findNext=false），Enter 下一个 / Shift+Enter 上一个，Esc 关闭。 */
(function () {
  var input = document.getElementById('q');
  var count = document.getElementById('count');

  function render(matches) {
    if (!input.value) {
      count.textContent = '';
      count.classList.remove('none');
      return;
    }
    count.textContent = matches.total === 0 ? '无结果' : matches.active + '/' + matches.total;
    count.classList.toggle('none', matches.total === 0);
  }

  function send(forward, findNext) {
    window.findbarApi.query(input.value, forward, findNext);
    if (!input.value) render({ active: 0, total: 0 });
  }

  input.addEventListener('input', function () { send(true, false); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      send(!e.shiftKey, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      window.findbarApi.close();
    }
  });
  document.getElementById('prev').addEventListener('click', function () { send(false, true); });
  document.getElementById('next').addEventListener('click', function () { send(true, true); });
  document.getElementById('close').addEventListener('click', function () { window.findbarApi.close(); });

  window.findbarApi.onInit(function (init) {
    input.value = init.text || '';
    input.focus();
    input.select();
    // 打开时若已有上次搜索词：直接在新页面里重查（Chrome 行为）
    if (input.value) send(true, false);
    else render({ active: 0, total: 0 });
  });
  window.findbarApi.onMatches(render);
  window.findbarApi.ready();
})();
