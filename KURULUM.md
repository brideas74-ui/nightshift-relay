# Dünya geneli lobi (Search → herkesin lobisi çıksın)

## Nasıl çalışıyor?
- İnternette **7/24 açık küçük bir sunucu** (relay) olur. Oyun (.exe veya tarayıcı) açılınca **Lobbies → Search** bu sunucuya bağlanır ve **herkesin açtığı herkese-açık lobileri** listeler.
- Lobi kurunca da aynı sunucuda kurulur; oyuncular arası mesajlar sunucu üzerinden geçer. **Port açma, IP girme, localhost yok.**
- Sunucuya oyun dosyası konmaz; sadece `server.js` (RELAY_ONLY=1). 8 kişilik bir lobi için çok küçük trafik, 1 küçük sunucu yüzlerce oyuncuyu kaldırır.
- Dünya geneli için **bir sunucu şart** (oyuncular birbirini başka türlü bulamaz). Sunucu yoksa LAN modu yine çalışır (aşağıda).

## 1) Ücretsiz, istek gelince açılıp boşta kapanan sunucu (Render)
Render'ın ücretsiz web servisi tam bunu yapar: ilk istek/bağlantı gelince açılır (~1 dk), **15 dk boyunca hiç HTTP isteği veya WebSocket mesajı gelmezse kendi kendine kapanır** ve kapalıyken ücretsiz saat harcamaz. Üstüne `server.js` **lobiyi 15 dk sonra kendisi kapatır** (herkesi atar, 1 dk önce oyunculara uyarı gider) → kimse kalmazsa sunucu uyur.

1. GitHub hesabı aç/gir: https://github.com/new → yeni depo (örn. `nightshift-relay`, Public olabilir).
2. `relay_deploy` klasörünün **içindeki** dosyaları (`server.js`, `package.json`, `render.yaml`, `Dockerfile`) depoya yükle ("uploading an existing file").
3. Render hesabı: https://dashboard.render.com/register (GitHub ile giriş).
4. Render panelinde **New → Blueprint** → deponu seç → Apply. (`render.yaml` her şeyi ayarlar: ücretsiz plan, `RELAY_ONLY=1`, `LOBBY_MAX_MIN=15`.)
   Elle istersen: **New → Web Service** → depo → Runtime *Node*, Build `npm install`, Start `node server.js`, Instance type **Free**, Environment: `RELAY_ONLY=1`.
5. Deploy bitince adresin `https://nightshift-relay-xxxx.onrender.com` gibi olur. `…/health` açınca `{"ok":1,...}` görürsen hazır.
6. Adresi `assets/netconfig.js` içine yaz (bölüm 2).

Bilmen gerekenler:
- Sunucu uykudayken ilk Search/Create **~1 dk** sürer; oyun bunu algılar, "Server is waking up…" yazar ve sunucuyu kendisi uyandırıp bekler.
- Lobi süresi `LOBBY_MAX_MIN` (dk) ile değişir; `0` = sınırsız. **Süre dolunca oynanan oyun da biter** (lobi toplam ömrü 15 dk). Daha uzun istersen 30/45 yaz.
- Oyun içinde Lobbies ekranı açık kalırsa 2 dk sonra otomatik yenileme durur (sunucuyu boşuna uyanık tutmasın).
- Render'ın ücretsiz planı aylık saat/bant genişliği sınırı içerir ve Render servisi istediği zaman yeniden başlatabilir; güncel limitler: https://render.com/free
- Başka bir seçenek (kredi kartı ister, ücretsiz kota içinde, boşta sıfıra iner): Google Cloud Run, WebSocket destekler.

**Kendi VPS'in (Ubuntu) varsa**
```
RELAY_ONLY=1 PORT=8000 node server.js
```
`wss://` için Caddy/nginx ile HTTPS ters-proxy kur (WebSocket'e izin ver).

## 2) Oyuna adresi yaz
`assets/netconfig.js` içinde:
```js
servers: ['wss://nightshift-relay.onrender.com'],
```
(`https://...` yazarsan da olur, otomatik `wss://` yapılır.) Sonra Store klasöründe `build_test.bat` ile yeniden paketle.
Adres `YOUR-SERVER` kaldığı sürece online arama kapalıdır, sadece LAN çalışır.

## 3) Oyun içinde
- **Lobbies** açılınca otomatik arar, her 5 sn yeniler. Listeden lobiye tıkla → katıl. Satırda ping (ms) ve LAN etiketi görünür.
- **Quick play**: boş yeri olan lobiye girer; yoksa online sunucuda yeni lobi kurar.
- **Create lobby → Where: Online (worldwide)**.

## LAN (aynı Wi-Fi / ağ, internet ve sunucu gerekmez) – sadece .exe
- Lobi kuran: **Create lobby → Where: LAN (this PC hosts)**. Oyun kendi içinde sunucuyu açar.
- Diğerleri: **Search** → lobi **LAN** etiketiyle otomatik çıkar, tıkla katıl.
- Windows Güvenlik Duvarı ilk seferde sorarsa **Özel ağ için izin ver** de.

## Güvenlik / limitler (server.js)
IP başına 12 bağlantı, sunucuda en fazla 300 lobi, lobi ömrü `LOBBY_MAX_MIN` (varsayılan 15 dk), istemci başına saniyede 300 mesaj üstü yok sayılır, 75 sn sessiz bağlantı atılır, 25 sn'de bir keep-alive. Değiştirmek için ortam değişkenleri: `MAX_PER_IP`, `MAX_LOBBIES`, `TRUST_PROXY=0` (proxy arkasında değilsen).
`server.js` değişirse `relay_deploy/guncelle.bat` ile kopyala ve sunucuya yeniden yükle.
