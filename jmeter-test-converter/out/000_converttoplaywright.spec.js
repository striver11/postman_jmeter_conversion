
import { test, expect } from '@playwright/test';
import { variables } from './variables.js';

test('convertToPlaywright', async ({ request }) => {

  const startTime = Date.now();

  const response = await request.get('https://jsonplaceholder.typicode.com/todos/1');
  const responseTime = Date.now() - startTime;
  const pwResponse = await response.json();
  // Post-response Script (Tests)

  // Status code is 200
    expect(response.status()).toBe(200);

  // Response time less than 2000ms
    expect(responseTime).toBeLessThan(2000);

  // UserId is equal to 1
    expect(pwResponse.userId).toBe(1);

  // Completed is equal to false
    expect(pwResponse.completed).toBe(false);

  // Title is equal to false
    expect(pwResponse.title).toBe("delectus aut autem");

});
