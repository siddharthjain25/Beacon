import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { hashKey, maskKey } from '../crypto.js';

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  apiKeyHash: {
    type: String,
    unique: true,
    sparse: true,
  },
  apiKeyDisplay: {
    type: String,
  },
  apiKey: {
    type: String,
    default: () => `bc_${nanoid(32)}`,
  },
  firstName: {
    type: String,
    required: true,
    trim: true,
  },
  lastName: {
    type: String,
    required: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Hash password and API key before saving
userSchema.pre('save', async function () {
  if (this.isModified('password')) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }

  // Hash the API key if it's set/modified, and clear the plaintext field
  if (this.isModified('apiKey') && this.apiKey) {
    this.apiKeyHash = hashKey(this.apiKey);
    this.apiKeyDisplay = maskKey(this.apiKey);
    this.apiKey = undefined; // Prevent plaintext storage
  } else if (!this.apiKeyHash && this.apiKey) {
    this.apiKeyHash = hashKey(this.apiKey);
    this.apiKeyDisplay = maskKey(this.apiKey);
    this.apiKey = undefined;
  }
});

// Method to compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);

export default User;
