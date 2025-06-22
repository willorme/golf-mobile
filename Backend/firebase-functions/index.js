const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();

// User Management Functions
exports.createUserProfile = functions.auth.user().onCreate(async (user) => {
  try {
    await db.collection('users').doc(user.uid).set({
      userId: user.uid,
      email: user.email,
      name: user.displayName || '',
      username: user.email.split('@')[0], // Default username from email
      createDate: admin.firestore.FieldValue.serverTimestamp(),
      updateDate: admin.firestore.FieldValue.serverTimestamp(),
      golfHandicap: 54.0, // Default maximum handicap
      isPublic: true,
      stats: {
        totalRounds: 0,
        bestScore: null,
        averageScore: null,
        lastPlayedDate: null
      }
    });
    console.log(`Created user profile for ${user.uid}`);
  } catch (error) {
    console.error('Error creating user profile:', error);
  }
});

// Golf Round Management
exports.calculateHandicap = functions.firestore
  .document('rounds/{roundId}')
  .onCreate(async (snap, context) => {
    const round = snap.data();
    const userId = round.userId;
    
    try {
      // Get user's recent rounds (last 20)
      const roundsSnapshot = await db
        .collection('rounds')
        .where('userId', '==', userId)
        .orderBy('roundDate', 'desc')
        .limit(20)
        .get();
      
      const rounds = roundsSnapshot.docs.map(doc => doc.data());
      
      // Calculate new handicap
      const newHandicap = calculateHandicapIndex(rounds);
      
      // Calculate stats
      const stats = calculatePlayerStats(rounds);
      
      // Update user document
      await db.collection('users').doc(userId).update({
        golfHandicap: newHandicap,
        updateDate: admin.firestore.FieldValue.serverTimestamp(),
        stats: stats
      });
      
      console.log(`Updated handicap for user ${userId}: ${newHandicap}`);
    } catch (error) {
      console.error('Error calculating handicap:', error);
    }
  });

// Friend Request Management
exports.sendFriendRequest = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }
  
  const { recipientId } = data;
  const requesterId = context.auth.uid;
  
  if (requesterId === recipientId) {
    throw new functions.https.HttpsError('invalid-argument', 'Cannot send friend request to yourself');
  }
  
  try {
    // Check if friendship already exists
    const existingFriendship = await db
      .collection('friendships')
      .where('userId1', 'in', [requesterId, recipientId])
      .where('userId2', 'in', [requesterId, recipientId])
      .get();
    
    if (!existingFriendship.empty) {
      throw new functions.https.HttpsError('already-exists', 'Friendship already exists');
    }
    
    // Create friendship document
    await db.collection('friendships').add({
      userId1: requesterId,
      userId2: recipientId,
      requester: requesterId,
      status: 'pending',
      createDate: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return { success: true, message: 'Friend request sent' };
  } catch (error) {
    console.error('Error sending friend request:', error);
    throw new functions.https.HttpsError('internal', 'Failed to send friend request');
  }
});

// Leaderboard Generation
exports.generateLeaderboard = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
  }
  
  const { period = 'month', limit = 50 } = data;
  
  try {
    const startDate = getStartDate(period);
    
    // Get recent rounds
    const roundsSnapshot = await db
      .collection('rounds')
      .where('roundDate', '>=', startDate)
      .orderBy('roundDate', 'desc')
      .get();
    
    // Group by user and calculate best scores
    const userScores = {};
    roundsSnapshot.docs.forEach(doc => {
      const round = doc.data();
      if (!userScores[round.userId] || round.score < userScores[round.userId].score) {
        userScores[round.userId] = {
          userId: round.userId,
          score: round.score,
          courseName: round.courseName,
          roundDate: round.roundDate
        };
      }
    });
    
    // Get user details and create leaderboard
    const leaderboard = [];
    for (const [userId, scoreData] of Object.entries(userScores)) {
      const userDoc = await db.collection('users').doc(userId).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        leaderboard.push({
          ...scoreData,
          name: userData.name,
          username: userData.username,
          handicap: userData.golfHandicap
        });
      }
    }
    
    // Sort by score and add positions
    leaderboard.sort((a, b) => a.score - b.score);
    leaderboard.forEach((entry, index) => {
      entry.position = index + 1;
    });
    
    return leaderboard.slice(0, limit);
  } catch (error) {
    console.error('Error generating leaderboard:', error);
    throw new functions.https.HttpsError('internal', 'Failed to generate leaderboard');
  }
});

// Helper Functions
function calculateHandicapIndex(rounds) {
  if (rounds.length < 5) return 54.0;
  
  const differentials = rounds
    .filter(round => round.score && round.courseRating && round.slopeRating)
    .map(round => {
      return (round.score - round.courseRating) * 113 / round.slopeRating;
    })
    .sort((a, b) => a - b);
  
  if (differentials.length === 0) return 54.0;
  
  const numToUse = getNumberOfDifferentials(differentials.length);
  const lowestDifferentials = differentials.slice(0, numToUse);
  
  const average = lowestDifferentials.reduce((sum, diff) => sum + diff, 0) / lowestDifferentials.length;
  return Math.min(Math.max(average * 0.96, 0), 54.0);
}

function getNumberOfDifferentials(totalRounds) {
  if (totalRounds >= 20) return 8;
  if (totalRounds >= 15) return 6;
  if (totalRounds >= 10) return 4;
  if (totalRounds >= 8) return 3;
  if (totalRounds >= 6) return 2;
  return 1;
}

function calculatePlayerStats(rounds) {
  if (rounds.length === 0) {
    return {
      totalRounds: 0,
      bestScore: null,
      averageScore: null,
      lastPlayedDate: null
    };
  }
  
  const scores = rounds.filter(r => r.score).map(r => r.score);
  const bestScore = Math.min(...scores);
  const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const lastPlayedDate = rounds[0].roundDate; // Already sorted by date desc
  
  return {
    totalRounds: rounds.length,
    bestScore: bestScore,
    averageScore: Math.round(averageScore * 10) / 10,
    lastPlayedDate: lastPlayedDate
  };
}

function getStartDate(period) {
  const now = new Date();
  switch (period) {
    case 'week':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    case 'year':
      return new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
    default:
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  }
}
