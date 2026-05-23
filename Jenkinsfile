pipeline {
    agent any

    environment {
        APP_NAME = "beacon"
        IMAGE_BACKEND = "beacon-backend:latest"
        IMAGE_CLIENT = "beacon-client:latest"
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
                    echo "Files in root:"
                    ls -la
                    if [ -d "client" ]; then
                        echo "Files in client:"
                        ls -la client
                    else
                        echo "WARNING: 'client' directory not found!"
                    fi
                    docker --version
                '''
            }
        }

        stage('Build & Deploy') {
            steps {
                sh '''
                    # Function to run docker-compose if available, else plain docker
                    if command -v docker-compose >/dev/null 2>&1; then
                        echo "Using docker-compose..."
                        docker-compose down || true
                        docker-compose build --no-cache
                        docker-compose up -d
                    elif docker compose version >/dev/null 2>&1; then
                        echo "Using docker compose (V2)..."
                        docker compose down || true
                        docker compose build --no-cache
                        docker compose up -d
                    else
                        echo "Compose not found. Using plain Docker commands..."
                        
                        # Stop existing containers if any
                        docker stop beacon-backend beacon-client beacon-mongo || true
                        docker rm beacon-backend beacon-client beacon-mongo || true
                        
                        # Start MongoDB
                        docker run -d --name beacon-mongo -p 27017:27017 mongo:latest
                        
                        # Build and Start Backend
                        docker build -t ${IMAGE_BACKEND} .
                        docker run -d --name beacon-backend \
                            -p 3000:3000 \
                            --link beacon-mongo:mongodb \
                            -e MONGODB_URI=mongodb://mongodb:27017/beacon \
                            ${IMAGE_BACKEND}
                            
                        # Build and Start Client (if directory exists)
                        if [ -d "client" ]; then
                            docker build -t ${IMAGE_CLIENT} ./client
                            docker run -d --name beacon-client \
                                -p 8080:80 \
                                --link beacon-backend:backend \
                                ${IMAGE_CLIENT}
                        fi
                    fi
                '''
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
    }

    post {
        always {
            sh 'docker ps'
        }
    }
}
