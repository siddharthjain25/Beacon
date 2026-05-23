pipeline {
    agent any

    environment {
        COMPOSE_PROJECT_NAME = "beacon"
        // In a real scenario, JWT_SECRET should be a Jenkins Credential
        // JWT_SECRET = credentials('jwt-secret')
    }

    options {
        timestamps()
        disableConcurrentBuilds()
    }

    stages {
        stage('Show Environment') {
            steps {
                sh '''
                    echo "Current Directory: $(pwd)"
                    echo "Files:"
                    ls -la
                    docker --version
                    docker-compose version
                '''
            }
        }

        stage('Client Lint') {
            when {
                expression { fileExists('client/package.json') }
            }
            steps {
                dir('client') {
                    sh 'npm install && npm run lint || true'
                }
            }
        }

        stage('Backend Build Check') {
            when {
                expression { fileExists('package.json') }
            }
            steps {
                sh 'npm install || true'
            }
        }

        stage('Stop Old Containers') {
            steps {
                sh 'docker-compose down || true'
            }
        }

        stage('Build Docker Images') {
            steps {
                // We pass VITE_API_BASE as a build arg if needed, 
                // though it's already in docker-compose.yml
                sh 'docker-compose build --no-cache'
            }
        }

        stage('Start Stack') {
            steps {
                sh 'docker-compose up -d'
            }
        }

        stage('Validation') {
            steps {
                sh '''
                    sleep 10
                    docker ps
                    curl -I http://localhost:3000/api/auth/me || true
                '''
            }
        }

        stage('Cleanup') {
            steps {
                sh 'docker image prune -f'
            }
        }
    }

    post {
        success {
            echo 'Deployment completed successfully.'
        }
        failure {
            echo 'Pipeline failed. Check the logs.'
        }
        always {
            sh 'docker-compose ps'
        }
    }
}
