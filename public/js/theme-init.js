(function () {
  try {
    var t = localStorage.getItem('agro_theme');
    if (t !== 'light' && t !== 'dark') t = 'dark';
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'light' ? '#ecf8ee' : '#06130e');
  } catch (e) { /* armazenamento indisponível: mantém o tema escuro */ }
})();
