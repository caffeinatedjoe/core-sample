import { handleRelay } from './allow.js';

export default {
  fetch(request) {
    return handleRelay(request);
  },
};
