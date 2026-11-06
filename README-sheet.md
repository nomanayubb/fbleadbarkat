# Send every lead to Google Sheets (free, no CRM)

1. Create a Google Sheet. Open **Extensions > Apps Script**.
2. Delete the code there and paste this (change `CHANGE_ME` to any secret text you invent):

```js
var SECRET = 'CHANGE_ME';
var HEAD = ['Time','Order number','Name','Phone','Email','Address','City','Country','Postal code','Ad name','Form ID','Page ID','Lead ID'];

function doPost(e) {
  var d = JSON.parse(e.postData.contents);
  if (d.secret !== SECRET) return ContentService.createTextOutput('no');
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var s = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    if (s.getLastRow() === 0) s.appendRow(HEAD);
    var ids = s.getRange(2, 13, Math.max(s.getLastRow() - 1, 1), 1).getValues().flat();
    if (ids.indexOf(String(d.leadId)) === -1)   // no duplicate rows
      s.appendRow([d.time, d.orderNumber, d.name, "'" + d.phone, d.email, d.address, d.city, d.country, d.zip, d.adName, d.formId, d.pageId, String(d.leadId)]);
  } finally { lock.releaseLock(); }
  return ContentService.createTextOutput('ok');
}
```

3. Click **Deploy > New deployment > Web app**. Execute as: **Me**. Who has access: **Anyone**. Click Deploy and approve the permissions. Copy the **Web app URL**.
4. In Render > Environment add:
   - `SHEET_WEBHOOK_URL` = that URL
   - `SHEET_SECRET` = the same secret text you used in step 2
5. Save. Every new lead now adds a row.
