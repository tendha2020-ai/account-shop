// script.js
// Fetch inventory and render cards for the index page

async function loadInventory() {
  try {
    // If we have saved inventory in localStorage (after admin edits), use it
    const saved = localStorage.getItem('accounts');
    if (saved) {
      const accounts = JSON.parse(saved);
      renderAccounts(accounts);
      return accounts;
    }
    // Otherwise load from the bundled JSON file
    const response = await fetch('inventory.json');
    const accounts = await response.json();
    renderAccounts(accounts);
    return accounts;
  } catch (err) {
    console.error('Error loading inventory:', err);
    return [];
  }
}

function renderAccounts(accounts) {
  const container = document.getElementById('account-list');
  if (!container) return;
  // Clear existing
  container.innerHTML = '';
  accounts.forEach((acc) => {
    const card = document.createElement('div');
    card.className = 'account-card';
    card.innerHTML = `
      <h2>${acc.name}</h2>
      <p><strong>Skins:</strong> ${acc.skins}</p>
      <p><strong>V‑Bucks:</strong> ${acc.vbucks}</p>
      <p><strong>Price:</strong> ${acc.price}</p>
      <p class="status ${acc.status.toLowerCase()}"><strong>Status:</strong> ${acc.status}</p>
    `;
    container.appendChild(card);
  });
}

// Only run on index page when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('account-list')) {
    loadInventory();
  }
  // Admin page logic
  const loginButton = document.getElementById('login-button');
  if (loginButton) {
    loginButton.addEventListener('click', () => {
      const pwd = document.getElementById('admin-password').value;
      if (pwd === adminPassword) {
        document.getElementById('login-section').style.display = 'none';
        document.getElementById('admin-section').style.display = 'block';
        initAdmin();
      } else {
        const errMsg = document.getElementById('login-error');
        if (errMsg) errMsg.style.display = 'block';
      }
    });
  }
  const addForm = document.getElementById('add-account-form');
  if (addForm) {
    addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      addNewAccount();
    });
  }
});

// Admin variables and functions
const adminPassword = 'admin123';
let adminAccounts = [];

async function initAdmin() {
  adminAccounts = await loadInventory();
  renderAdminAccounts();
}

function renderAdminAccounts() {
  const container = document.getElementById('admin-account-list');
  if (!container) return;
  container.innerHTML = '';
  adminAccounts.forEach((acc, index) => {
    const card = document.createElement('div');
    card.className = 'account-card';
    card.innerHTML = `
      <h2>${acc.name}</h2>
      <p><strong>Skins:</strong> ${acc.skins}</p>
      <p><strong>V‑Bucks:</strong> ${acc.vbucks}</p>
      <p><strong>Price:</strong> ${acc.price}</p>
      <p><strong>Status:</strong> <select data-index="${index}">
        <option value="Available" ${acc.status === 'Available' ? 'selected' : ''}>Available</option>
        <option value="Sold" ${acc.status === 'Sold' ? 'selected' : ''}>Sold</option>
      </select></p>
    `;
    // Attach change handler for status select
    container.appendChild(card);
  });
  // After adding all cards, attach change event listeners to selects
  container.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.getAttribute('data-index'), 10);
      adminAccounts[idx].status = e.target.value;
      saveAccounts();
      renderAccounts(adminAccounts);
    });
  });
}

function addNewAccount() {
  const name = document.getElementById('acc-name').value.trim();
  const skins = parseInt(document.getElementById('acc-skins').value, 10);
  const vbucks = parseInt(document.getElementById('acc-vbucks').value, 10);
  const price = document.getElementById('acc-price').value.trim();
  if (!name || isNaN(skins) || isNaN(vbucks) || !price) {
    alert('Please fill in all fields.');
    return;
  }
  const newAccount = {
    id: 'acc' + (adminAccounts.length + 1),
    name,
    skins,
    vbucks,
    price,
    status: 'Available'
  };
  adminAccounts.push(newAccount);
  saveAccounts();
  renderAdminAccounts();
  renderAccounts(adminAccounts);
  document.getElementById('add-account-form').reset();
}

function saveAccounts() {
  localStorage.setItem('accounts', JSON.stringify(adminAccounts));
}