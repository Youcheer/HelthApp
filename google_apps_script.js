// Copy and paste this code into your Google Apps Script editor (Extensions -> Apps Script from your Google Sheet).
// This is required to make the syncing work with your Health App.
// Important: Replace the existing code with this.
// Then click "Deploy" -> "New deployment", choose "Web app", execute as "Me", and access "Anyone".
// Use the new Web App URL in your Health App settings.

function doPost(e) {
   try {
      var rawData = e.postData.contents;
      var data = JSON.parse(rawData);
      var action = data.action;

      var ss = SpreadsheetApp.getActiveSpreadsheet();

      if (action === 'export') {
         // Save config
         var configSheet = getOrCreateSheet(ss, 'Config');
         configSheet.clear();
         configSheet.appendRow(['Key', 'Value']);
         configSheet.appendRow(['config', JSON.stringify(data.config || {})]);

         // Handle claims (Incremental Sync / Merge Logic)
         var claimsSheet = getOrCreateSheet(ss, 'Claims');
         var claimHeaders = ['syncId', 'policyYear', 'date', 'category', 'amount', 'hospital', 'description', 'days', 'timestamp'];
         if (claimsSheet.getLastRow() === 0) {
            claimsSheet.appendRow(claimHeaders);
         }
         mergeData(claimsSheet, data.claims, claimHeaders);

         // Handle premiums (Incremental Sync / Merge Logic)
         var premiumsSheet = getOrCreateSheet(ss, 'Premiums');
         var premiumHeaders = ['syncId', 'policyYear', 'paidDate', 'dueDate', 'amount', 'timestamp'];
         if (premiumsSheet.getLastRow() === 0) {
            premiumsSheet.appendRow(premiumHeaders);
         }
         mergeData(premiumsSheet, data.premiums, premiumHeaders);

         var output = ContentService.createTextOutput(JSON.stringify({ status: 'success' }));
         output.setMimeType(ContentService.MimeType.JSON);
         return output;
      }
   } catch (err) {
      var errOut = ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }));
      errOut.setMimeType(ContentService.MimeType.JSON);
      return errOut;
   }
}

/**
 * Merges incoming JSON data with existing Sheet data based on 'syncId'
 */
function mergeData(sheet, incomingData, headers) {
   if (!incomingData || incomingData.length === 0) return;

   var lastRow = sheet.getLastRow();
   var existingSyncIds = {};

   // Read existing sync IDs if sheet has data
   if (lastRow > 1) {
      var existingData = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      for (var i = 0; i < existingData.length; i++) {
         var syncId = existingData[i][0]; // Assuming syncId is always the first column A
         if (syncId) {
            existingSyncIds[syncId] = i + 2; // Row number in Google Sheets is 1-indexed, +1 for header
         }
      }
   }

   var newRows = [];

   for (var i = 0; i < incomingData.length; i++) {
      var rowObj = incomingData[i];
      if (!rowObj.syncId) continue; // Skip invalid records

      var rowArray = [];
      for (var h = 0; h < headers.length; h++) {
         rowArray.push(rowObj[headers[h]] || "");
      }

      if (existingSyncIds[rowObj.syncId]) {
         // Update an existing row
         sheet.getRange(existingSyncIds[rowObj.syncId], 1, 1, headers.length).setValues([rowArray]);
      } else {
         // Add new row to backlog
         newRows.push(rowArray);
      }
   }

   // Append all new rows at once (Batch insert for speed)
   if (newRows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);
   }
}

function doGet(e) {
   try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var result = {
         config: null,
         claims: [],
         premiums: []
      };

      var configSheet = ss.getSheetByName('Config');
      if (configSheet) {
         var v = configSheet.getRange(2, 2).getValue();
         if (v) result.config = JSON.parse(v);
      }

      var claimsSheet = ss.getSheetByName('Claims');
      if (claimsSheet && claimsSheet.getLastRow() > 1) {
         var rows = claimsSheet.getRange(2, 1, claimsSheet.getLastRow() - 1, 9).getValues();
         result.claims = rows.map(function (r) {
            return {
               syncId: r[0], policyYear: r[1], date: r[2], category: r[3], amount: r[4], hospital: r[5], description: r[6], days: r[7] === "" ? null : r[7], timestamp: r[8]
            };
         });
      }

      var premiumsSheet = ss.getSheetByName('Premiums');
      if (premiumsSheet && premiumsSheet.getLastRow() > 1) {
         var rows = premiumsSheet.getRange(2, 1, premiumsSheet.getLastRow() - 1, 6).getValues();
         result.premiums = rows.map(function (r) {
            return {
               syncId: r[0], policyYear: r[1], paidDate: r[2], dueDate: r[3], amount: r[4], timestamp: r[5]
            };
         });
      }

      var output = ContentService.createTextOutput(JSON.stringify({ status: 'success', data: result }));
      output.setMimeType(ContentService.MimeType.JSON);
      return output;

   } catch (err) {
      var errOut = ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }));
      errOut.setMimeType(ContentService.MimeType.JSON);
      return errOut;
   }
}

function getOrCreateSheet(ss, name) {
   var sheet = ss.getSheetByName(name);
   if (!sheet) {
      sheet = ss.insertSheet(name);
   }
   return sheet;
}

// Optional Setup
function InitialSetup() {
   getOrCreateSheet(SpreadsheetApp.getActiveSpreadsheet(), 'Config');
}
