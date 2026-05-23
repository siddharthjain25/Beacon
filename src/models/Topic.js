import mongoose from 'mongoose';

const topicSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  isPrivate: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Ensure a user can't have two topics with the same name
topicSchema.index({ name: 1, owner: 1 }, { unique: true });

const Topic = mongoose.model('Topic', topicSchema);

export default Topic;
