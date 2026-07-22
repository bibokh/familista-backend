var fs = require('fs');

var css = fs.readFileSync('_squad_css_extracted.css', 'utf8');
var fn = fs.readFileSync('_squad_fn_extracted.js', 'utf8');

var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
  + 'body{background:#0d1117;margin:0;padding:0;font-family:system-ui,sans-serif}'
  + '*{box-sizing:border-box}'
  + css
  + '</style></head><body>'
  + '<div style="padding:32px 0 0">'
  + '<div style="padding:0 32px 28px"><h1 style="margin:0;font-size:22px;font-weight:700;color:#f1f5f9;letter-spacing:-.3px">Squad</h1></div>'
  + '<div id="root"></div>'
  + '</div>'
  + '<script>'
  + 'function _sqSubHtml(){return "";}'
  + fn
  + '; var html = renderSquadHTML();'
  + ' var el = document.getElementById("root");'
  + ' el.innerHTML = html;'
  + ' var home = document.getElementById("sq-home");'
  + ' if(home){ el.innerHTML = ""; el.appendChild(home); }'
  + '</script>'
  + '</body></html>';

fs.writeFileSync('squad_preview.html', html);
console.log('Preview written to squad_preview.html (' + html.length + ' bytes)');
