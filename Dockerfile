FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html sw.js manifest.webmanifest icon.svg icon-192.png icon-512.png /usr/share/nginx/html/
