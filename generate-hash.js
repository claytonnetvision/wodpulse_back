// generate-hash.js (execute uma vez só)
const bcrypt = require('bcryptjs');

const password = 'abc123v6'; // senha que você quer usar
const saltRounds = 10;

bcrypt.hash(password, saltRounds, (err, hash) => {
  if (err) {
    console.error(err);
    return;
  }
  console.log('Hash gerado para a senha "abc123v6":');
  console.log(hash);
});