const {test,expect}=require("@playwright/test");
const {TEST_PASSWORD,startIsolatedTestApp}=require("./test-app.cjs");
let app;
test.beforeAll(async()=>{app=await startIsolatedTestApp();});
test.afterAll(async()=>{await app?.stop();});
async function login(page,user="bojan"){
 await page.goto(app.baseUrl);
 await page.locator("#localTestUser").selectOption(user);
 await page.locator("#localTestPassword").fill(TEST_PASSWORD);
 await page.locator("#localTestLoginBtn").click();
 await expect(page.locator("#app")).toBeVisible();await page.waitForLoadState("networkidle");
}
async function settings(page){
 await page.locator("#toolsMenu > summary").click();
 await page.getByRole("button",{name:"Nastavitve obračuna in arhiva",exact:true}).click();
 await page.getByRole("button",{name:"Odpri tehnične nastavitve",exact:true}).click();
 await expect(page.locator("#technicalConfigDialog")).toBeVisible();
}
test("boss config editor is readable on phone, saves, reloads and restores prior file",async({page})=>{
 await page.setViewportSize({width:390,height:844});await login(page);await settings(page);
 await expect(page.getByLabel("Največji PDF (MB)",{exact:true})).toHaveValue("50");
 expect(await page.locator("#technicalConfigFields").evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 await page.getByLabel("Največji PDF (MB)",{exact:true}).fill("55");
 await page.getByRole("button",{name:"Shrani in osveži",exact:true}).click();
 await expect(page.locator("#appConfirmMessage")).toContainText("50 → 55");
 await page.locator("#appConfirmAccept").click();
 await expect(page.locator("#technicalConfigDialog")).toBeHidden();
 await page.waitForLoadState("networkidle");await settings(page);
 await expect(page.getByLabel("Največji PDF (MB)",{exact:true})).toHaveValue("55");
 await page.getByRole("button",{name:"Prejšnja različica",exact:true}).click();
 await expect(page.getByLabel("Največji PDF (MB)",{exact:true})).toHaveValue("50");
 await expect(page.locator("#technicalConfigError")).toContainText("samo osnutek");
 await page.getByRole("button",{name:"Shrani in osveži",exact:true}).click();await page.locator("#appConfirmAccept").click();
 await expect(page.locator("#technicalConfigDialog")).toBeHidden();
 await page.waitForLoadState("networkidle");await settings(page);
 await expect(page.getByLabel("Največji PDF (MB)",{exact:true})).toHaveValue("50");
});
test("large PDF attaches through real picker, persists without auto-download on reopen",async({page})=>{
 await login(page);await page.locator("#newTodoButton").click();
 await page.getByRole("checkbox",{name:"Bojan",exact:true}).check();
 await page.locator("#todoFormTask").fill("PDF browser QA");await page.locator("#todoFormClient").fill("PDF QA client");
 const bytes=Buffer.alloc(2*1048576,32);bytes.write("%PDF-1.4\n");bytes.write("\n%%EOF",bytes.length-6);
 await page.locator("#todoFormAttachmentInput").setInputFiles({name:"vecji.pdf",mimeType:"application/pdf",buffer:bytes});
 await expect(page.locator("#todoFormPhotoList")).toContainText("vecji.pdf");
 await expect(page.locator("#todoFormVideoStatus")).toContainText("PDF je naložen");
 await page.locator("#saveTodoDialog").click();await expect(page.locator("#todoDialog")).toBeHidden();
 const row=page.locator(".todo-item",{hasText:"PDF browser QA"}).first();
 await row.locator(".edit-todo").click();await expect(page.locator("#todoFormPhotoList")).toContainText("vecji.pdf");
 await expect(page.locator("#saveTodoDialog")).toBeEnabled();
 const autoPdf=await page.evaluate(()=>performance.getEntriesByType("resource").filter(e=>/\/api\/attachments\/[a-f0-9]{64}$/.test(new URL(e.name).pathname)));
 expect(autoPdf).toHaveLength(0);
});
