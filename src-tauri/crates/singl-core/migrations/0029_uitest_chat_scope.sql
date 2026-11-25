-- App Tests case chats move to their own scope, out of the assistant's chat list.
UPDATE `assistant_chats` SET `scope` = 'uitest'
WHERE `scope` = 'app' AND (
  `id` IN (SELECT `chatId` FROM `ui_test_cases` WHERE `chatId` <> '')
  OR `id` IN (
    SELECT json_extract(c.value, '$.chatId') FROM `automation_runs` r, json_each(r.`result`, '$.cases') c
    WHERE r.`kind` = 'uitest' AND json_valid(r.`result`)
  )
);
